import type { Coord, DailyWeather, Itinerary, Pace, Place, PlaceCategory, TravelMode } from '@atp/core';

export type DestinationSummary = {
  id: string;
  name: string;
  country: string;
  center: Coord;
  timezone: string;
  currency: string;
  suggestedDailyBudget: number;
  interests: string[];
};

export type Destination = DestinationSummary & { places: Place[] };

export type PlanFormState = {
  destinationId: string;
  startDate: string;
  endDate: string;
  budgetTotal: number;
  travelers: number;
  pace: Pace;
  dayStart: string;
  dayEnd: string;
  maxWalkMinutes: number;
  preferredModes: TravelMode[];
  interests: Record<string, number>;
  avoidCategories: PlaceCategory[];
  mustSeeIds: string[];
  lodgingPlaceId?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload && typeof payload.error === 'string' && payload.error) || response.statusText;
    throw new ApiError(message, response.status, payload?.issues);
  }
  return payload as T;
}

export function fetchDestinations(): Promise<{ destinations: DestinationSummary[] }> {
  return request('/api/destinations');
}

export function fetchDestination(id: string): Promise<{ destination: Destination }> {
  return request(`/api/destinations/${encodeURIComponent(id)}`);
}

export function fetchForecast(
  id: string,
  startDate: string,
  endDate: string,
): Promise<{ provider: string; forecast: DailyWeather[] }> {
  const query = new URLSearchParams({ startDate, endDate });
  return request(`/api/destinations/${encodeURIComponent(id)}/forecast?${query}`);
}

export function requestPlan(form: PlanFormState): Promise<{ itinerary: Itinerary; weatherProvider: string }> {
  return request('/api/plan', {
    method: 'POST',
    body: JSON.stringify({
      destinationId: form.destinationId,
      startDate: form.startDate,
      endDate: form.endDate,
      budgetTotal: form.budgetTotal,
      ...(form.lodgingPlaceId ? { lodgingPlaceId: form.lodgingPlaceId } : {}),
      preferences: {
        interests: form.interests,
        pace: form.pace,
        dayStart: form.dayStart,
        dayEnd: form.dayEnd,
        maxWalkMinutes: form.maxWalkMinutes,
        preferredModes: form.preferredModes,
        avoidCategories: form.avoidCategories,
        mustSeeIds: form.mustSeeIds,
        travelers: form.travelers,
      },
    }),
  });
}
