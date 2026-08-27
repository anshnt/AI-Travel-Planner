import {
  dateRange,
  normalizePreferences,
  planTrip,
  replan,
  type DayPlan,
  type Itinerary,
  type PlanRequest,
  type Place,
  type ScheduledItem,
} from '@atp/core';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';

import { DESTINATIONS, destinationSummaries, findDestination } from './data/destinations.js';
import { SyntheticWeatherProvider, type WeatherProvider } from './providers/weather.js';
import {
  defaultPreferencesInput,
  formatIssues,
  planRequestSchema,
  replanRequestSchema,
  type PlanRequestInput,
} from './schema.js';

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

  /**
   * Turns validated input into a `PlanRequest`, or an error to return.
   *
   * Shared by /plan and /replan so the two cannot drift: a re-plan has to be the
   * same planner over the same pool, or it is a different product.
   */
  const buildPlanRequest = async (
    input: PlanRequestInput,
  ): Promise<
    | { ok: true; planRequest: PlanRequest; byId: Map<string, Place> }
    | { ok: false; status: number; body: Record<string, unknown> }
  > => {
    const destination = findDestination(input.destinationId);
    if (!destination) {
      return { ok: false, status: 404, body: { error: 'Unknown destination', id: input.destinationId } };
    }

    const byId = new Map(destination.places.map((place) => [place.id, place]));

    let candidates: Place[] = destination.places;
    if (input.includePlaceIds && input.includePlaceIds.length > 0) {
      const allowed = new Set(input.includePlaceIds);
      candidates = destination.places.filter((place) => allowed.has(place.id));
    }

    const lodging = input.lodgingPlaceId ? byId.get(input.lodgingPlaceId) : undefined;
    if (input.lodgingPlaceId && !lodging) {
      return { ok: false, status: 400, body: { error: 'Unknown lodgingPlaceId', id: input.lodgingPlaceId } };
    }

    const dates = dateRange(input.startDate, input.endDate);
    const weather = await dependencies.weather.forecast(destination.center, dates);

    return {
      ok: true,
      byId,
      planRequest: {
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
          ...(input.foodShare === undefined ? {} : { foodShare: input.foodShare }),
        },
        // The engine owns the defaults, so the API does not have to restate them.
        preferences: normalizePreferences(input.preferences ?? defaultPreferencesInput()),
        candidates,
        weather,
        ...(lodging ? { lodging } : {}),
      },
    };
  };

  app.post('/api/plan', asyncRoute<Record<string, never>>(async (request, response) => {
    const input = planRequestSchema.parse(request.body);
    const built = await buildPlanRequest(input);
    if (!built.ok) {
      response.status(built.status).json(built.body);
      return;
    }

    response.json({
      itinerary: planTrip(built.planRequest),
      weatherProvider: dependencies.weather.name,
    });
  }));

  app.post('/api/replan', asyncRoute<Record<string, never>>(async (request, response) => {
    const input = replanRequestSchema.parse(request.body);
    const built = await buildPlanRequest(input);
    if (!built.ok) {
      response.status(built.status).json(built.body);
      return;
    }

    const unknown = input.scheduled.filter((entry) => !built.byId.has(entry.placeId));
    if (unknown.length > 0) {
      response.status(400).json({
        error: 'Unknown placeId in scheduled',
        ids: unknown.map((entry) => entry.placeId),
      });
      return;
    }

    const existing = rebuildItinerary(input, built.planRequest, built.byId);
    const result = replan({
      itinerary: existing,
      base: built.planRequest,
      disruptions: input.disruptions,
      pinned: input.pinned,
      ...(input.now ? { now: input.now } : {}),
    });

    response.json({
      itinerary: result.itinerary,
      changes: result.changes,
      summary: result.summary,
      pinned: result.pinned,
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
 * Rebuilds the itinerary the client is holding, from the stop list it sent.
 *
 * Only the fields re-planning actually reads are reconstructed -- which stops sit
 * on which day, and when. Totals and notes are recomputed from scratch by the
 * planner, so sending them back and forth would only create a chance for the two
 * sides to disagree.
 */
function rebuildItinerary(
  input: { startDate: string; endDate: string; scheduled: readonly ScheduledItemInput[] },
  planRequest: PlanRequest,
  byId: Map<string, Place>,
): Itinerary {
  const emptyTotals = {
    cost: 0,
    mealCost: 0,
    travelMinutes: 0,
    walkMinutes: 0,
    activeMinutes: 0,
    distanceMeters: 0,
  };

  const days: DayPlan[] = dateRange(input.startDate, input.endDate).map((date) => {
    const items: ScheduledItem[] = input.scheduled
      .filter((entry) => entry.date === date)
      .sort((a, b) => a.start - b.start)
      .flatMap((entry) => {
        const place = byId.get(entry.placeId);
        if (!place) return [];
        return [
          {
            placeId: entry.placeId,
            place,
            kind: entry.kind,
            ...(entry.mealKind ? { mealKind: entry.mealKind } : {}),
            start: entry.start,
            end: entry.start + place.dwellMinutes,
            cost: 0,
            reasons: [],
            cautions: [],
          },
        ];
      });

    return {
      date,
      weekday: new Date(`${date}T00:00:00Z`).getUTCDay() as DayPlan['weekday'],
      items,
      totals: { ...emptyTotals },
      notes: [],
    };
  });

  return {
    destination: planRequest.destination,
    startDate: input.startDate,
    endDate: input.endDate,
    currency: planRequest.budget.currency,
    days,
    totals: { ...emptyTotals, budgetRemaining: planRequest.budget.total, placesVisited: 0, mealsBooked: 0 },
    score: 0,
    rejected: [],
  };
}

type ScheduledItemInput = {
  date: string;
  placeId: string;
  start: number;
  kind: ScheduledItem['kind'];
  mealKind?: 'breakfast' | 'lunch' | 'dinner';
};

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
