import type {
  Coord,
  DailyWeather,
  DietaryTag,
  Itinerary,
  MealKind,
  Pace,
  Place,
  PlaceCategory,
  TravelMode,
} from '@atp/core';

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
  meals: MealKind[];
  dietary: DietaryTag[];
  cuisines: string[];
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

/**
 * The API is deployed separately from this app, so its response is treated as
 * untrusted in shape as well as in content. Only the presentational string
 * arrays are patched up: a UI that white-screens because an older API did not
 * send `cautions` is a worse outcome than one missing a caution line.
 */
function normalizeItinerary(itinerary: Itinerary): Itinerary {
  return {
    ...itinerary,
    days: itinerary.days.map((day) => ({
      ...day,
      notes: day.notes ?? [],
      items: day.items.map((item) => ({
        ...item,
        reasons: item.reasons ?? [],
        cautions: item.cautions ?? [],
      })),
    })),
    rejected: itinerary.rejected ?? [],
  };
}

export async function requestPlan(
  form: PlanFormState,
): Promise<{ itinerary: Itinerary; weatherProvider: string }> {
  const payload = await request<{ itinerary: Itinerary; weatherProvider: string }>('/api/plan', {
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
        meals: form.meals,
        dietary: form.dietary,
        cuisines: form.cuisines,
      },
    }),
  });
  return { ...payload, itinerary: normalizeItinerary(payload.itinerary) };
}
