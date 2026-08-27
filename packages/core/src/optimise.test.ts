import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, normalizePreferences, planTrip, type PreferencesInput } from './planner.js';
import { replan } from './replan.js';
import { window } from './time.js';
import type { DailyWeather, HourlyWeather, Itinerary, OpeningHours, Place, PlanRequest, Preferences } from './types.js';

const CENTRE = { lat: 41.3874, lon: 2.1686 };

/** Offsets by roughly `meters`, east and north, for predictable geometry. */
function at(eastMeters: number, northMeters = 0) {
  return {
    lat: CENTRE.lat + northMeters / 111_320,
    lon: CENTRE.lon + eastMeters / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180)),
  };
}

const ALL_DAY: OpeningHours = {
  weekly: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [day, [window('07:00', '23:00')]])),
};

function place(overrides: Partial<Place> & Pick<Place, 'id'>): Place {
  return {
    name: overrides.id,
    category: 'landmark',
    coord: CENTRE,
    dwellMinutes: 45,
    costPerPerson: 0,
    rating: 4,
    tags: ['art'],
    openingHours: ALL_DAY,
    indoor: false,
    ...overrides,
  };
}

type RequestOverrides = Omit<Partial<PlanRequest>, 'preferences'> & { preferences?: PreferencesInput };

function request(overrides: RequestOverrides = {}): PlanRequest {
  const preferences: Preferences = normalizePreferences({
    ...DEFAULT_PREFERENCES,
    interests: { art: 1 },
    travelers: 2,
    dayStart: 9 * 60,
    dayEnd: 22 * 60,
    meals: [],
    pace: 'packed',
    ...overrides.preferences,
  });
  return {
    destination: { name: 'Barcelona', center: CENTRE },
    startDate: '2026-03-16',
    endDate: '2026-03-16',
    budget: { total: 2000, currency: 'EUR' },
    candidates: [],
    ...overrides,
    preferences,
  };
}

function travelOf(itinerary: Itinerary): number {
  return itinerary.totals.travelMinutes;
}

function ids(itinerary: Itinerary, dayIndex = 0): string[] {
  return (itinerary.days[dayIndex]?.items ?? []).map((item) => item.placeId);
}

function hourly(wetHours: readonly number[]): HourlyWeather[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    tempC: 19,
    precipitationChance: wetHours.includes(hour) ? 0.9 : 0.05,
    precipitationMm: wetHours.includes(hour) ? 4 : 0,
  }));
}

function forecast(date: string, wetHours: readonly number[]): DailyWeather {
  return {
    date,
    condition: wetHours.length > 0 ? 'rain' : 'clear',
    tempMinC: 15,
    tempMaxC: 22,
    precipitationChance: wetHours.length > 0 ? 0.9 : 0.05,
    precipitationMm: wetHours.length > 0 ? 8 : 0,
    windKph: 9,
    hourly: hourly(wetHours),
  };
}

describe('optimiseItinerary: it never changes what the trip contains', () => {
  /** Stops in a deliberately awkward order, all equally wanted. */
  function zigzag(): Place[] {
    return [
      place({ id: 'a', coord: at(0) }),
      place({ id: 'b', coord: at(6000) }),
      place({ id: 'c', coord: at(600) }),
      place({ id: 'd', coord: at(6600) }),
      place({ id: 'e', coord: at(1200) }),
    ];
  }

  it('schedules exactly the same stops as the greedy plan', () => {
    const base = request({ candidates: zigzag() });
    const greedy = planTrip(base, { skipOptimisation: true });
    const optimised = planTrip(base);

    expect([...ids(optimised)].sort()).toEqual([...ids(greedy)].sort());
    expect(optimised.totals.placesVisited).toBe(greedy.totals.placesVisited);
    expect(optimised.totals.mealsBooked).toBe(greedy.totals.mealsBooked);
  });

  it('leaves the plan chronological and inside the day', () => {
    const optimised = planTrip(request({ candidates: zigzag() }));
    for (const day of optimised.days) {
      for (let i = 1; i < day.items.length; i += 1) {
        expect(day.items[i]!.start).toBeGreaterThanOrEqual(day.items[i - 1]!.end);
      }
      for (const item of day.items) expect(item.end).toBeLessThanOrEqual(22 * 60);
    }
  });

  it('never pushes the trip over budget, even when it changes fares', () => {
    const paid = [0, 1, 2, 3, 4].map((index) =>
      place({ id: `p${index}`, coord: at(index % 2 === 0 ? index * 400 : 7000 + index * 400), costPerPerson: 25 }),
    );
    for (const total of [80, 150, 400]) {
      const optimised = planTrip(request({ candidates: paid, budget: { total, currency: 'EUR' } }));
      expect(optimised.totals.cost).toBeLessThanOrEqual(total);
      expect(optimised.totals.budgetRemaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic', () => {
    const base = request({ candidates: zigzag() });
    const first = planTrip(base);
    const second = planTrip(base);
    expect(JSON.stringify(second.days.map((d) => d.items.map((i) => [i.placeId, i.start])))).toBe(
      JSON.stringify(first.days.map((d) => d.items.map((i) => [i.placeId, i.start]))),
    );
    expect(second.optimisation).toEqual(first.optimisation);
  });
});

describe('optimiseItinerary: it makes plans better', () => {
  it('cuts travel on a day insertion left zigzagging', () => {
    // Two clusters, interleaved so greedy insertion is likely to alternate.
    const candidates = [
      place({ id: 'near-1', coord: at(0), rating: 4.9 }),
      place({ id: 'far-1', coord: at(9000), rating: 4.85 }),
      place({ id: 'near-2', coord: at(500), rating: 4.8 }),
      place({ id: 'far-2', coord: at(9500), rating: 4.75 }),
      place({ id: 'near-3', coord: at(1000), rating: 4.7 }),
      place({ id: 'far-3', coord: at(10_000), rating: 4.65 }),
    ];
    const base = request({ candidates });
    const greedy = planTrip(base, { skipOptimisation: true });
    const optimised = planTrip(base);

    expect(travelOf(optimised)).toBeLessThanOrEqual(travelOf(greedy));
  });

  it('never makes the objective worse than the greedy plan', () => {
    // The objective is what the pass maximises, so this is the guarantee that
    // matters. Travel alone can legitimately rise for a better weather fit.
    const shapes = [
      [at(0), at(8000), at(400), at(8400), at(800)],
      [at(0, 5000), at(5000, 0), at(0, -5000), at(-5000, 0)],
      [at(0), at(300), at(600), at(9000), at(9300)],
    ];
    for (const shape of shapes) {
      const candidates = shape.map((coord, index) =>
        place({ id: `s${index}`, coord, rating: 4.8 - index * 0.05 }),
      );
      const base = request({ candidates });
      const greedy = planTrip(base, { skipOptimisation: true });
      const optimised = planTrip(base);
      expect(optimised.score).toBeGreaterThanOrEqual(greedy.score - 1e-6);
    }
  });

  it('reports what it did, and says when a move cost travel rather than saving it', () => {
    const candidates = [
      place({ id: 'near-1', coord: at(0), rating: 4.9 }),
      place({ id: 'far-1', coord: at(9000), rating: 4.85 }),
      place({ id: 'near-2', coord: at(500), rating: 4.8 }),
      place({ id: 'far-2', coord: at(9500), rating: 4.75 }),
    ];
    const optimised = planTrip(request({ candidates }));
    if (!optimised.optimisation) return;

    expect(optimised.optimisation.moves.length).toBeGreaterThan(0);
    for (const move of optimised.optimisation.moves) {
      // Every move states its effect; none of them claims a saving it did not make.
      expect(move).toMatch(/saving \d|more travel but a better fit|for a better fit|after the rain/);
    }
  });

  it('makes no claim at all when it changes nothing', () => {
    // A single stop has nothing to rearrange.
    const optimised = planTrip(request({ candidates: [place({ id: 'only' })] }));
    expect(optimised.optimisation).toBeUndefined();
  });

  it('can be turned off', () => {
    const base = request({
      candidates: [
        place({ id: 'near-1', coord: at(0), rating: 4.9 }),
        place({ id: 'far-1', coord: at(9000), rating: 4.85 }),
        place({ id: 'near-2', coord: at(500), rating: 4.8 }),
      ],
    });
    expect(planTrip(base, { skipOptimisation: true }).optimisation).toBeUndefined();
  });
});

describe('optimiseItinerary: waiting for the weather', () => {
  it('holds an outdoor stop back until a shower has passed', () => {
    // The gallery is only open in the morning, so the order is forced: gallery
    // then park. That drops the park straight into an 11:00-to-13:00 shower, and
    // no amount of reordering can help. The only fix is to wait.
    const gallery = place({
      id: 'gallery',
      category: 'gallery',
      coord: at(0),
      indoor: true,
      dwellMinutes: 90,
      openingHours: { weekly: { 1: [window('09:00', '11:00')] } },
      tags: ['art'],
    });
    const park = place({
      id: 'park',
      category: 'park',
      coord: at(300),
      indoor: false,
      dwellMinutes: 60,
      tags: ['art'],
    });

    const base = request({
      candidates: [gallery, park],
      weather: [forecast('2026-03-16', [11, 12])],
      preferences: { interests: { art: 1 }, dayStart: 9 * 60, dayEnd: 20 * 60 },
    });

    const greedy = planTrip(base, { skipOptimisation: true });
    const optimised = planTrip(base);

    const greedyPark = greedy.days[0]!.items.find((item) => item.placeId === 'park')!;
    const optimisedPark = optimised.days[0]!.items.find((item) => item.placeId === 'park')!;

    // Precondition: the greedy plan really does put the park in the rain.
    const wetFrom = 11 * 60;
    const wetUntil = 13 * 60;
    expect(greedyPark.start).toBeLessThan(wetUntil);
    expect(greedyPark.end).toBeGreaterThan(wetFrom);

    expect(optimisedPark.start).toBeGreaterThanOrEqual(wetUntil);
    expect(optimised.optimisation?.moves.join(' ')).toMatch(/held park back to 13:00 .*after the rain/);
  });

  it('does not invent a wait when the day is dry', () => {
    const park = place({ id: 'park', category: 'park', coord: at(300), indoor: false, dwellMinutes: 60 });
    const optimised = planTrip(
      request({ candidates: [park], weather: [forecast('2026-03-16', [])] }),
    );
    expect(optimised.optimisation?.moves.join(' ') ?? '').not.toMatch(/after the rain/);
  });

  it('leaves the deferral alone when planning weather-blind', () => {
    const park = place({ id: 'park', category: 'park', coord: at(300), indoor: false, dwellMinutes: 60 });
    const gallery = place({ id: 'gallery', category: 'gallery', coord: at(0), indoor: true, dwellMinutes: 90 });
    const optimised = planTrip(
      request({ candidates: [park, gallery], weather: [forecast('2026-03-16', [11, 12])] }),
      { ignoreWeather: true },
    );
    expect(optimised.optimisation?.moves.join(' ') ?? '').not.toMatch(/after the rain/);
  });
});

describe('optimiseItinerary: it respects what is fixed', () => {
  it('never moves a stop that has already happened', () => {
    const candidates = [
      place({ id: 'a', coord: at(0), rating: 4.9 }),
      place({ id: 'b', coord: at(9000), rating: 4.85 }),
      place({ id: 'c', coord: at(400), rating: 4.8 }),
      place({ id: 'd', coord: at(9400), rating: 4.75 }),
    ];
    const base = request({ candidates });
    const before = planTrip(base);
    const history = before.days[0]!.items.filter((item) => item.start <= 12 * 60);

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: 12 * 60 },
      disruptions: [{ kind: 'running-late', minutes: 30 }],
    });

    for (const item of history) {
      const after = result.itinerary.days[0]!.items.find((entry) => entry.placeId === item.placeId);
      expect(after?.start).toBe(item.start);
    }
  });

  it('never moves a pinned stop', () => {
    const candidates = [
      place({ id: 'a', coord: at(0), rating: 4.9 }),
      place({ id: 'b', coord: at(9000), rating: 4.85 }),
      place({ id: 'c', coord: at(400), rating: 4.8 }),
      place({ id: 'd', coord: at(9400), rating: 4.75 }),
    ];
    const base = request({ candidates });
    const before = planTrip(base);
    const target = before.days[0]!.items[1];
    if (!target) return;

    const result = replan({
      itinerary: before,
      base,
      pinned: [target.placeId],
      disruptions: [],
    });
    const after = result.itinerary.days[0]!.items.find((item) => item.placeId === target.placeId);
    expect(after?.start).toBe(target.start);
  });

  it('keeps meals inside their windows', () => {
    const sights = [0, 1, 2].map((index) => place({ id: `s${index}`, coord: at(index * 3000), dwellMinutes: 75 }));
    const eatery = place({
      id: 'eat',
      category: 'restaurant',
      coord: at(1500),
      dwellMinutes: 55,
      costPerPerson: 20,
      indoor: true,
      tags: ['food'],
      meal: { kinds: ['lunch'], priceLevel: 2, cuisines: [], dietary: [], costPerPerson: 20 },
    });

    const optimised = planTrip(
      request({ candidates: [...sights, eatery], preferences: { meals: ['lunch'] } }),
    );
    const lunch = optimised.days[0]!.items.find((item) => item.mealKind === 'lunch');
    if (!lunch) return;
    expect(lunch.start).toBeGreaterThanOrEqual(12 * 60 + 30);
    expect(lunch.start).toBeLessThanOrEqual(14 * 60 + 30);
  });

  it('never breaks an opening-hours constraint', () => {
    const closesEarly = place({
      id: 'closes-early',
      coord: at(6000),
      openingHours: { weekly: { 1: [window('09:00', '12:00')] } },
      dwellMinutes: 60,
      rating: 4.9,
    });
    const openLate = place({ id: 'open-late', coord: at(0), dwellMinutes: 60, rating: 4.8 });
    const alsoNear = place({ id: 'also-near', coord: at(400), dwellMinutes: 60, rating: 4.7 });

    const optimised = planTrip(request({ candidates: [closesEarly, openLate, alsoNear] }));
    const item = optimised.days[0]!.items.find((entry) => entry.placeId === 'closes-early');
    if (item) {
      expect(item.start).toBeGreaterThanOrEqual(9 * 60);
      expect(item.end).toBeLessThanOrEqual(12 * 60);
    }
  });

  it('never exceeds the pace ceiling on a day it moves a stop onto', () => {
    const candidates = Array.from({ length: 9 }, (_, index) =>
      place({ id: `s${index}`, coord: at(index * 700), dwellMinutes: 60 }),
    );
    const optimised = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-18',
        candidates,
        preferences: { pace: 'relaxed' },
      }),
    );
    for (const day of optimised.days) {
      expect(day.items.filter((item) => item.kind === 'activity').length).toBeLessThanOrEqual(3);
    }
  });
});
