import type { Coord, Place } from '@atp/core';

import { BARCELONA_PLACES } from './barcelona.js';
import { KYOTO_PLACES } from './kyoto.js';
import { LISBON_PLACES } from './lisbon.js';

export type Destination = {
  id: string;
  name: string;
  country: string;
  center: Coord;
  timezone: string;
  currency: string;
  /** Rough per-person daily spend for a comfortable trip, used to seed the budget field. */
  suggestedDailyBudget: number;
  /** Interest tags that actually appear on this destination's places. */
  interests: string[];
  places: Place[];
};

function interestsOf(places: readonly Place[]): string[] {
  const counts = new Map<string, number>();
  for (const place of places) {
    for (const tag of place.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

export const DESTINATIONS: Destination[] = [
  {
    id: 'barcelona',
    name: 'Barcelona',
    country: 'Spain',
    center: { lat: 41.3874, lon: 2.1686 },
    timezone: 'Europe/Madrid',
    currency: 'EUR',
    suggestedDailyBudget: 95,
    interests: interestsOf(BARCELONA_PLACES),
    places: BARCELONA_PLACES,
  },
  {
    id: 'kyoto',
    name: 'Kyoto',
    country: 'Japan',
    center: { lat: 35.0116, lon: 135.7681 },
    timezone: 'Asia/Tokyo',
    currency: 'JPY',
    suggestedDailyBudget: 12_000,
    interests: interestsOf(KYOTO_PLACES),
    places: KYOTO_PLACES,
  },
  {
    id: 'lisbon',
    name: 'Lisbon',
    country: 'Portugal',
    center: { lat: 38.7223, lon: -9.1393 },
    timezone: 'Europe/Lisbon',
    currency: 'EUR',
    suggestedDailyBudget: 80,
    interests: interestsOf(LISBON_PLACES),
    places: LISBON_PLACES,
  },
];

export function findDestination(id: string): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.id === id);
}

/** Destination list without the bulky place arrays, for the picker. */
export function destinationSummaries(): Omit<Destination, 'places'>[] {
  return DESTINATIONS.map(({ places: _places, ...summary }) => summary);
}
