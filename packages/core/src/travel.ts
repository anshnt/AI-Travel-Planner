import { routeMeters } from './geo.js';
import type { Coord, Place, Preferences, TravelLeg, TravelMode } from './types.js';

/**
 * Door-to-door characteristics of each mode.
 *
 * `speedKph` is an effective speed, not a top speed: it already absorbs traffic
 * lights, stairs, and the general friction of moving through a city.
 * `overheadMinutes` is the fixed cost of using the mode at all -- waiting for a
 * train, finding the car, unlocking a bike -- which is what makes a short
 * transit hop slower than simply walking.
 */
export const MODE_PROFILES: Record<
  TravelMode,
  { speedKph: number; overheadMinutes: number; costPerKm: number; fixedCost: number; perPerson: boolean }
> = {
  walk: { speedKph: 4.6, overheadMinutes: 0, costPerKm: 0, fixedCost: 0, perPerson: false },
  cycle: { speedKph: 13, overheadMinutes: 4, costPerKm: 0, fixedCost: 2.5, perPerson: true },
  transit: { speedKph: 19, overheadMinutes: 8, costPerKm: 0, fixedCost: 2.2, perPerson: true },
  drive: { speedKph: 24, overheadMinutes: 6, costPerKm: 1.1, fixedCost: 1.5, perPerson: false },
};

export const ALL_TRAVEL_MODES: TravelMode[] = ['walk', 'cycle', 'transit', 'drive'];

export type LegEstimate = {
  mode: TravelMode;
  minutes: number;
  meters: number;
  cost: number;
};

export function estimateLeg(from: Coord, to: Coord, mode: TravelMode, travelers: number): LegEstimate {
  const profile = MODE_PROFILES[mode];
  const meters = routeMeters(from, to);
  const minutes = profile.overheadMinutes + (meters / 1000 / profile.speedKph) * 60;
  const partySize = profile.perPerson ? Math.max(1, travelers) : 1;
  const cost = (profile.fixedCost + (meters / 1000) * profile.costPerKm) * partySize;
  return {
    mode,
    minutes: Math.round(minutes),
    meters: Math.round(meters),
    cost: Number(cost.toFixed(2)),
  };
}

/** A ride has to save at least this many minutes to be worth paying for. */
const RIDE_MUST_SAVE_MINUTES = 8;
/** Modes within this many minutes of the fastest count as tied, so cost decides. */
const SPEED_TIE_MINUTES = 4;

/**
 * Picks how to get between two places.
 *
 * The choice is deliberately not "whatever is fastest": a traveller who says
 * they will happily walk 25 minutes would rather walk 18 than pay for a train
 * that saves four. So walking wins whenever it is inside the stated tolerance
 * and nothing else is decisively faster.
 */
export function chooseLeg(from: Coord, to: Coord, preferences: Preferences): LegEstimate {
  const allowed = preferences.preferredModes.length > 0 ? preferences.preferredModes : ALL_TRAVEL_MODES;
  const estimates = allowed.map((mode) => estimateLeg(from, to, mode, preferences.travelers));
  if (estimates.length === 0) return estimateLeg(from, to, 'walk', preferences.travelers);

  const walking = estimates.find((estimate) => estimate.mode === 'walk');
  const fastest = estimates.reduce((best, estimate) => (estimate.minutes < best.minutes ? estimate : best));

  if (walking && walking.minutes <= preferences.maxWalkMinutes) {
    if (walking.minutes - fastest.minutes < RIDE_MUST_SAVE_MINUTES) return walking;
  }

  // A walk longer than the traveller signed up for is off the table -- otherwise
  // it would win the cost tie-break below on being free, and `maxWalkMinutes`
  // would mean nothing. It comes back only when there is no other way.
  const viable = estimates.filter(
    (estimate) => estimate.mode !== 'walk' || estimate.minutes <= preferences.maxWalkMinutes,
  );
  const pool = viable.length > 0 ? viable : estimates;
  const fastestViable = pool.reduce((best, estimate) => (estimate.minutes < best.minutes ? estimate : best));

  const tolerance = fastestViable.minutes + SPEED_TIE_MINUTES;
  return pool
    .filter((estimate) => estimate.minutes <= tolerance)
    .reduce((best, estimate) => (estimate.cost < best.cost ? estimate : best), fastestViable);
}

export function toLeg(fromPlaceId: string, toPlaceId: string, estimate: LegEstimate): TravelLeg {
  return {
    fromPlaceId,
    toPlaceId,
    mode: estimate.mode,
    minutes: estimate.minutes,
    meters: estimate.meters,
    cost: estimate.cost,
  };
}

/**
 * Cached pairwise travel estimates.
 *
 * The planner asks for the same legs thousands of times while it tries
 * insertions and local-search moves, so estimates are computed lazily and
 * memoised rather than built up front for every pair.
 */
export class TravelMatrix {
  private readonly places = new Map<string, Place>();
  private readonly cache = new Map<string, LegEstimate>();

  constructor(
    places: readonly Place[],
    private readonly preferences: Preferences,
  ) {
    for (const place of places) this.places.set(place.id, place);
  }

  register(place: Place): void {
    this.places.set(place.id, place);
  }

  has(placeId: string): boolean {
    return this.places.has(placeId);
  }

  between(fromPlaceId: string, toPlaceId: string): LegEstimate {
    if (fromPlaceId === toPlaceId) return { mode: 'walk', minutes: 0, meters: 0, cost: 0 };

    const key = `${fromPlaceId} ${toPlaceId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const from = this.places.get(fromPlaceId);
    const to = this.places.get(toPlaceId);
    if (!from || !to) {
      throw new Error(`TravelMatrix: unknown place id ${!from ? fromPlaceId : toPlaceId}`);
    }
    const estimate = chooseLeg(from.coord, to.coord, this.preferences);
    this.cache.set(key, estimate);
    return estimate;
  }

  leg(fromPlaceId: string, toPlaceId: string): TravelLeg {
    return toLeg(fromPlaceId, toPlaceId, this.between(fromPlaceId, toPlaceId));
  }

  minutes(fromPlaceId: string, toPlaceId: string): number {
    return this.between(fromPlaceId, toPlaceId).minutes;
  }
}
