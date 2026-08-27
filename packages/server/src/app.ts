import { dateRange, planTrip, type PlanRequest, type Place } from '@atp/core';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';

import { DESTINATIONS, destinationSummaries, findDestination } from './data/destinations.js';
import { SyntheticWeatherProvider, type WeatherProvider } from './providers/weather.js';
import { defaultPreferencesInput, formatIssues, planRequestSchema } from './schema.js';

export type AppDependencies = {
  weather: WeatherProvider;
};

export function defaultDependencies(): AppDependencies {
  return { weather: new SyntheticWeatherProvider() };
}

export function createApp(dependencies: AppDependencies = defaultDependencies()): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      destinations: DESTINATIONS.length,
      weatherProvider: dependencies.weather.name,
    });
  });

  app.get('/api/destinations', (_request, response) => {
    response.json({ destinations: destinationSummaries() });
  });

  app.get('/api/destinations/:id', (request, response) => {
    const destination = findDestination(request.params.id);
    if (!destination) {
      response.status(404).json({ error: 'Unknown destination', id: request.params.id });
      return;
    }
    response.json({ destination });
  });

  app.get('/api/destinations/:id/forecast', asyncRoute<{ id: string }>(async (request, response) => {
    const destination = findDestination(request.params.id);
    if (!destination) {
      response.status(404).json({ error: 'Unknown destination', id: request.params.id });
      return;
    }
    const { startDate, endDate } = request.query;
    if (typeof startDate !== 'string' || typeof endDate !== 'string') {
      response.status(400).json({ error: 'startDate and endDate query parameters are required' });
      return;
    }

    let dates: string[];
    try {
      dates = dateRange(startDate, endDate);
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
      return;
    }

    const forecast = await dependencies.weather.forecast(destination.center, dates);
    response.json({ provider: dependencies.weather.name, forecast });
  }));

  app.post('/api/plan', asyncRoute<Record<string, never>>(async (request, response) => {
    const input = planRequestSchema.parse(request.body);
    const destination = findDestination(input.destinationId);
    if (!destination) {
      response.status(404).json({ error: 'Unknown destination', id: input.destinationId });
      return;
    }

    const byId = new Map(destination.places.map((place) => [place.id, place]));

    let candidates: Place[] = destination.places;
    if (input.includePlaceIds && input.includePlaceIds.length > 0) {
      const allowed = new Set(input.includePlaceIds);
      candidates = destination.places.filter((place) => allowed.has(place.id));
    }

    const lodging = input.lodgingPlaceId ? byId.get(input.lodgingPlaceId) : undefined;
    if (input.lodgingPlaceId && !lodging) {
      response.status(400).json({ error: 'Unknown lodgingPlaceId', id: input.lodgingPlaceId });
      return;
    }

    const dates = dateRange(input.startDate, input.endDate);
    const weather = await dependencies.weather.forecast(destination.center, dates);

    const planRequest: PlanRequest = {
      destination: {
        name: destination.name,
        center: destination.center,
        timezone: destination.timezone,
      },
      startDate: input.startDate,
      endDate: input.endDate,
      budget: {
        total: input.budgetTotal,
        currency: destination.currency,
        ...(input.dailyCap === undefined ? {} : { dailyCap: input.dailyCap }),
      },
      preferences: input.preferences ?? defaultPreferencesInput(),
      candidates,
      weather,
      ...(lodging ? { lodging } : {}),
    };

    response.json({
      itinerary: planTrip(planRequest),
      weatherProvider: dependencies.weather.name,
    });
  }));

  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid request', issues: formatIssues(error) });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unexpected error';
    // Surfaced deliberately: the planner throws on genuinely malformed input, and
    // a silent 500 would make that impossible to debug from the client.
    response.status(500).json({ error: message });
  });

  return app;
}

/**
 * Routes an async handler's rejections into Express's error pipeline.
 *
 * Generic over the path parameters so that route-parameter typing survives the
 * wrapper -- without it, every `request.params.x` read degrades to `unknown`.
 */
function asyncRoute<Params>(
  handler: (request: Request<Params>, response: Response) => Promise<void>,
): (request: Request<Params>, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}
