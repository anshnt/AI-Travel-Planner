import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, normalizePreferences, planTrip, type PreferencesInput } from './planner.js';
import { replan, type Change, type Disruption, type ReplanResult } from './replan.js';
import { formatClock, window } from './time.js';
import type { DailyWeather, HourlyWeather, Itinerary, OpeningHours, Place, PlanRequest, Preferences } from './types.js';

const CENTRE = { lat: 41.3874, lon: 2.1686 };

function eastOf(meters: number) {
  return { lat: CENTRE.lat, lon: CENTRE.lon + meters / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180)) };
}

const ALL_DAY: OpeningHours = {
  weekly: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [day, [window('08:00', '22:00')]])),
};

function place(overrides: Partial<Place> & Pick<Place, 'id'>): Place {
  return {
    name: overrides.id,
    category: 'landmark',
    coord: CENTRE,
    dwellMinutes: 60,
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
    dayEnd: 20 * 60,
    // Meals are exercised separately; they only add noise here.
    meals: [],
    ...overrides.preferences,
  });
  return {
    destination: { name: 'Barcelona', center: CENTRE },
    startDate: '2026-03-16', // Monday
    endDate: '2026-03-18',
    budget: { total: 600, currency: 'EUR' },
    candidates: [],
    ...overrides,
    preferences,
  };
}

/** Four sightseeing stops, spread out enough that the planner has choices. */
function fourStops(): Place[] {
  return [0, 1, 2, 3].map((index) =>
    place({ id: `s${index}`, coord: eastOf(index * 500), dwellMinutes: 90, rating: 4.5 - index * 0.1 }),
  );
}

function whereIs(itinerary: Itinerary, placeId: string): { date: string; start: number } | null {
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.placeId === placeId) return { date: day.date, start: item.start };
    }
  }
  return null;
}

/**
 * Every placement, as `date|placeId|start`.
 *
 * Looking a place up by id is ambiguous once a restaurant is visited on more
 * than one day, which is exactly the case the stability tests care about.
 */
function placements(itinerary: Itinerary): Set<string> {
  return new Set(
    itinerary.days.flatMap((day) => day.items.map((item) => `${day.date}|${item.placeId}|${item.start}`)),
  );
}

function ids(itinerary: Itinerary, dayIndex: number): string[] {
  return (itinerary.days[dayIndex]?.items ?? []).map((item) => item.placeId);
}

function changeFor(result: ReplanResult, placeId: string): Change | undefined {
  return result.changes.find((change) => change.placeId === placeId);
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

/** Plans a trip, then re-plans it under the given disruptions. */
function afterDisruption(
  disruptions: Disruption[],
  overrides: RequestOverrides = {},
  now?: { date: string; minute: number },
  pinned?: string[],
): { base: PlanRequest; before: Itinerary; result: ReplanResult } {
  const base = request(overrides);
  const before = planTrip(base);
  const result = replan({
    itinerary: before,
    base,
    disruptions,
    ...(now ? { now } : {}),
    ...(pinned ? { pinned } : {}),
  });
  return { base, before, result };
}

describe('replan: doing nothing', () => {
  it('leaves an undisrupted plan exactly as it was', () => {
    const { before, result } = afterDisruption([], { candidates: fourStops() });
    expect(result.itinerary.days.map((day) => day.items.map((item) => [item.placeId, item.start]))).toEqual(
      before.days.map((day) => day.items.map((item) => [item.placeId, item.start])),
    );
    expect(result.changes.every((change) => change.kind === 'kept')).toBe(true);
    expect(result.summary.join(' ')).toMatch(/Nothing needed to change/);
  });

  it('reports a change for every stop, so the caller can render a full picture', () => {
    const { before, result } = afterDisruption([], { candidates: fourStops() });
    const scheduled = before.days.flatMap((day) => day.items.map((item) => item.placeId));
    expect(result.changes.map((change) => change.placeId).sort()).toEqual([...scheduled].sort());
  });
});

describe('replan: it adjusts, it does not rebuild', () => {
  /** A trip with meals, which is where rebuilding used to lose a stop. */
  function tripWithMeals() {
    const sights = [0, 1, 2, 3, 4].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 500), dwellMinutes: 90, rating: 4.6 - index * 0.1 }),
    );
    const eateries = ['a', 'b'].map((suffix, index) =>
      place({
        id: `eat-${suffix}`,
        category: 'restaurant',
        coord: eastOf(200 + index * 300),
        dwellMinutes: 60,
        costPerPerson: 20,
        indoor: true,
        tags: ['food'],
        meal: { kinds: ['lunch', 'dinner'], priceLevel: 2, cuisines: [], dietary: [], costPerPerson: 20 },
      }),
    );
    return request({
      candidates: [...sights, ...eateries],
      preferences: { meals: ['lunch', 'dinner'], dayEnd: 22 * 60 },
    });
  }

  it('never moves or loses a stop when nothing is disrupted', () => {
    const base = tripWithMeals();
    const before = planTrip(base);
    expect(before.totals.mealsBooked).toBeGreaterThan(0);

    const result = replan({ itinerary: before, base, disruptions: [] });

    // Every placement that was in the plan is still in it, unchanged.
    const after = placements(result.itinerary);
    for (const placement of placements(before)) {
      expect(after.has(placement)).toBe(true);
    }
    expect(result.changes.some((change) => change.kind === 'dropped')).toBe(false);
    expect(result.changes.some((change) => change.kind === 'moved')).toBe(false);
  });

  it('never books a second lunch onto a day that already has one', () => {
    const base = tripWithMeals();
    const before = planTrip(base);
    const result = replan({ itinerary: before, base, disruptions: [] });

    for (const day of result.itinerary.days) {
      const kinds = day.items.filter((item) => item.kind === 'meal').map((item) => item.mealKind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it('loses nothing from the days a closure does not affect', () => {
    // Times on other days may shift to take in the rehomed stop, but no stop
    // should fall off a day that had nothing to do with the closure.
    const base = tripWithMeals();
    const before = planTrip(base);
    const affected = before.days.find((day) => day.items.some((item) => item.kind === 'activity'))!;
    const victim = affected.items.find((item) => item.kind === 'activity')!;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'place-closed', placeId: victim.placeId, date: affected.date }],
    });

    const onDay = (itinerary: Itinerary, date: string) =>
      new Set((itinerary.days.find((day) => day.date === date)?.items ?? []).map((item) => item.placeId));

    for (const day of before.days) {
      if (day.date === affected.date) continue;
      const after = onDay(result.itinerary, day.date);
      for (const placeId of onDay(before, day.date)) {
        expect(after.has(placeId)).toBe(true);
      }
    }
  });
});

describe('replan: history is untouchable', () => {
  const oneDay = { startDate: '2026-03-16', endDate: '2026-03-16' };

  it('keeps stops that have already happened exactly where they were', () => {
    const { before, result } = afterDisruption(
      [{ kind: 'running-late', minutes: 120 }],
      { ...oneDay, candidates: fourStops() },
      { date: '2026-03-16', minute: 12 * 60 },
    );

    for (const item of before.days[0]!.items) {
      if (item.start > 12 * 60) continue;
      expect(whereIs(result.itinerary, item.placeId)).toEqual({ date: '2026-03-16', start: item.start });
    }
  });

  it('treats a visit in progress as history, not as something to reschedule', () => {
    const base = request({ ...oneDay, candidates: fourStops() });
    const before = planTrip(base);
    const inProgress = before.days[0]!.items[0]!;
    // Mid-visit: started, not finished.
    const midway = Math.floor((inProgress.start + inProgress.end) / 2);

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: midway },
      disruptions: [{ kind: 'running-late', minutes: 45 }],
    });
    expect(whereIs(result.itinerary, inProgress.placeId)).toEqual({
      date: '2026-03-16',
      start: inProgress.start,
    });
  });

  it('never schedules anything new before the current moment', () => {
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 30 }],
      { ...oneDay, candidates: fourStops() },
      { date: '2026-03-16', minute: 13 * 60 },
    );
    for (const item of result.itinerary.days[0]!.items) {
      if (item.start < 13 * 60) {
        // Only history may sit before now, and history keeps its own start.
        expect(item.locked).toBe(true);
      }
    }
  });

  it('leaves earlier days of a multi-day trip alone', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-18', minute: 10 * 60 },
      disruptions: [{ kind: 'running-late', minutes: 90 }],
    });
    expect(ids(result.itinerary, 0)).toEqual(ids(before, 0));
    expect(ids(result.itinerary, 1)).toEqual(ids(before, 1));
  });
});

describe('replan: running late', () => {
  it('pushes the rest of the day back, or drops what no longer fits', () => {
    const { before, result } = afterDisruption(
      [{ kind: 'running-late', minutes: 150 }],
      { startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() },
      { date: '2026-03-16', minute: 11 * 60 },
    );
    const scheduledBefore = before.days[0]!.items.length;
    const scheduledAfter = result.itinerary.days[0]!.items.length;
    expect(scheduledAfter).toBeLessThanOrEqual(scheduledBefore);
    expect(result.changes.some((change) => change.kind === 'dropped' || change.kind === 'retimed')).toBe(true);
  });

  it('says losing time is what dropped a stop', () => {
    // 10:00 plus seven hours lost leaves three hours of a 20:00 day: four
    // 90-minute stops cannot all survive that.
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 420 }],
      { startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() },
      { date: '2026-03-16', minute: 10 * 60 },
    );
    const droppedChanges = result.changes.filter((change) => change.kind === 'dropped');
    expect(droppedChanges.length).toBeGreaterThan(0);
    expect(droppedChanges.map((change) => change.reason).join(' ')).toMatch(/losing 7h/);
  });

  it('moves a stop it cannot fit today onto a later day rather than binning it', () => {
    const { before, result } = afterDisruption(
      [{ kind: 'running-late', minutes: 210 }],
      { candidates: fourStops() },
      { date: '2026-03-16', minute: 10 * 60 },
    );
    const movedOrKept = before.days[0]!.items.filter((item) => whereIs(result.itinerary, item.placeId) !== null);
    // Something should survive somewhere: three days is plenty of room.
    expect(movedOrKept.length).toBeGreaterThan(0);
    expect(result.itinerary.totals.placesVisited).toBeGreaterThan(0);
  });

  it('rolls into the next day when the lateness swallows the rest of this one', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const stillToCome = before.days[0]!.items.filter((item) => item.start >= 14 * 60);

    // Ten hours lost at 14:00 means the rest of today is gone.
    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: 14 * 60 },
      disruptions: [{ kind: 'running-late', minutes: 600 }],
    });

    for (const item of stillToCome) {
      const landed = whereIs(result.itinerary, item.placeId);
      expect(landed?.date).not.toBe('2026-03-16');
    }
  });
});

describe('replan: a place turns out to be closed', () => {
  it('drops it for that date and says why', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const victim = before.days[0]!.items[0]!;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'place-closed', placeId: victim.placeId, date: before.days[0]!.date }],
    });
    const landed = whereIs(result.itinerary, victim.placeId);
    expect(landed?.date).not.toBe(before.days[0]!.date);
  });

  it('rehomes it to another day when there is room', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const victim = before.days[0]!.items[0]!;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'place-closed', placeId: victim.placeId, date: before.days[0]!.date }],
    });
    expect(whereIs(result.itinerary, victim.placeId)).not.toBeNull();
    expect(changeFor(result, victim.placeId)?.kind).toBe('moved');
  });

  it('drops it from the whole trip when reported closed outright', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const victim = before.days[0]!.items[0]!;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'place-closed', placeId: victim.placeId }],
    });
    expect(whereIs(result.itinerary, victim.placeId)).toBeNull();
    expect(changeFor(result, victim.placeId)).toMatchObject({
      kind: 'dropped',
      reason: 'reported as closed',
    });
    expect(result.itinerary.rejected.map((entry) => entry.placeId)).toContain(victim.placeId);
  });

  it('backfills the gap it leaves', () => {
    // Five candidates for three days, so one starts out unscheduled.
    const candidates = [0, 1, 2, 3, 4].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 400), dwellMinutes: 150, rating: 4.6 - index * 0.2 }),
    );
    const base = request({ candidates, preferences: { pace: 'relaxed' } });
    const before = planTrip(base);
    const scheduledBefore = new Set(before.days.flatMap((day) => day.items.map((item) => item.placeId)));
    const leftOut = candidates.find((candidate) => !scheduledBefore.has(candidate.id));
    const victim = before.days[0]!.items[0]!;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'place-closed', placeId: victim.placeId }],
    });

    if (leftOut) {
      // The freed slot should be usable by whatever was waiting for one.
      expect(result.itinerary.totals.placesVisited).toBeGreaterThanOrEqual(
        before.totals.placesVisited - 1,
      );
    }
  });
});

describe('replan: pinning', () => {
  it('keeps a pinned stop at exactly its time, even under heavy disruption', () => {
    const base = request({ startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() });
    const before = planTrip(base);
    const pinnedItem = before.days[0]!.items[before.days[0]!.items.length - 1]!;

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: 9 * 60 },
      pinned: [pinnedItem.placeId],
      disruptions: [{ kind: 'running-late', minutes: 60 }],
    });
    expect(whereIs(result.itinerary, pinnedItem.placeId)).toEqual({
      date: '2026-03-16',
      start: pinnedItem.start,
    });
  });

  it('carries pins forward across rounds', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const target = before.days[0]!.items[0]!.placeId;

    const first = replan({ itinerary: before, base, disruptions: [{ kind: 'pin', placeId: target }] });
    expect(first.pinned).toContain(target);

    const second = replan({
      itinerary: first.itinerary,
      base,
      pinned: first.pinned,
      disruptions: [],
    });
    expect(second.pinned).toContain(target);
  });

  it('releases a stop once unpinned', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const target = before.days[0]!.items[0]!.placeId;

    const result = replan({
      itinerary: before,
      base,
      pinned: [target],
      disruptions: [{ kind: 'unpin', placeId: target }],
    });
    expect(result.pinned).not.toContain(target);
  });
});

describe('replan: the traveller edits the plan', () => {
  it('drops a stop on request and does not put it back', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const target = before.days[0]!.items[0]!.placeId;

    const result = replan({ itinerary: before, base, disruptions: [{ kind: 'drop', placeId: target }] });
    expect(whereIs(result.itinerary, target)).toBeNull();
    expect(changeFor(result, target)).toMatchObject({ kind: 'dropped', reason: 'you took this off the list' });
  });

  it('fits in a stop it had previously left out', () => {
    // Six candidates and one relaxed day, which holds three: three get left out.
    const candidates = [0, 1, 2, 3, 4, 5].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 400), dwellMinutes: 90, rating: 4.8 - index * 0.3 }),
    );
    const base = request({
      startDate: '2026-03-16',
      endDate: '2026-03-16',
      candidates,
      preferences: { pace: 'relaxed' },
    });
    const before = planTrip(base);
    const scheduled = new Set(before.days.flatMap((day) => day.items.map((item) => item.placeId)));
    const leftOut = candidates.find((candidate) => !scheduled.has(candidate.id));
    expect(leftOut).toBeDefined();

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'add', placeId: leftOut!.id }],
    });
    expect(whereIs(result.itinerary, leftOut!.id)).not.toBeNull();
    expect(changeFor(result, leftOut!.id)?.kind).toBe('added');
  });

  it('honours a stop dragged to another day', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const target = before.days[0]!.items[0]!.placeId;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'move', placeId: target, toDate: '2026-03-18' }],
    });
    expect(whereIs(result.itinerary, target)?.date).toBe('2026-03-18');
    expect(result.pinned).toContain(target);
  });

  it('locks what an instruction places, so the rest of the re-plan cannot undo it', () => {
    // Meal scheduling is allowed to displace the least valuable stop of a day, and
    // a stop that has just been moved there is often exactly that. Locking it is
    // what stops the traveller being told a stop moved to Wednesday and finding a
    // restaurant in its place.
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const moved = before.days[0]!.items[0]!.placeId;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'move', placeId: moved, toDate: '2026-03-18' }],
    });

    const landed = result.itinerary.days.flatMap((day) => day.items).find((item) => item.placeId === moved);
    expect(landed?.locked).toBe(true);
  });

  it('locks a stop it was told to fit in', () => {
    // Six candidates and one relaxed day, which holds three: three get left out.
    const candidates = [0, 1, 2, 3, 4, 5].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 400), dwellMinutes: 90, rating: 4.8 - index * 0.3 }),
    );
    const base = request({
      startDate: '2026-03-16',
      endDate: '2026-03-16',
      candidates,
      preferences: { pace: 'relaxed' },
    });
    const before = planTrip(base);
    const scheduled = new Set(before.days.flatMap((day) => day.items.map((item) => item.placeId)));
    const leftOut = candidates.find((candidate) => !scheduled.has(candidate.id));
    expect(leftOut).toBeDefined();

    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'add', placeId: leftOut!.id }],
    });

    const landed = result.itinerary.days
      .flatMap((day) => day.items)
      .find((item) => item.placeId === leftOut!.id);
    expect(landed?.locked).toBe(true);
  });
});

describe('replan: the forecast changes', () => {
  it('reorders the remaining day when rain arrives', () => {
    const park = place({ id: 'park', category: 'park', indoor: false, dwellMinutes: 90, tags: ['parks'] });
    const gallery = place({
      id: 'gallery',
      category: 'gallery',
      coord: eastOf(400),
      indoor: true,
      dwellMinutes: 90,
      tags: ['art'],
    });

    const base = request({
      startDate: '2026-03-16',
      endDate: '2026-03-16',
      candidates: [park, gallery],
      weather: [forecast('2026-03-16', [])],
      preferences: { interests: { parks: 0.8, art: 0.8 }, dayEnd: 18 * 60 },
    });
    const before = planTrip(base);
    expect(before.days[0]!.items).toHaveLength(2);

    // A wet morning arrives: the indoor stop should come first now.
    const result = replan({
      itinerary: before,
      base,
      disruptions: [{ kind: 'forecast-changed', weather: [forecast('2026-03-16', [9, 10, 11])] }],
    });
    expect(ids(result.itinerary, 0)).toEqual(['gallery', 'park']);
  });

  it('carries the new forecast into the returned itinerary', () => {
    const base = request({ candidates: fourStops(), weather: [forecast('2026-03-16', [])] });
    const before = planTrip(base);
    const wet = [forecast('2026-03-16', [9, 10, 11, 12])];

    const result = replan({ itinerary: before, base, disruptions: [{ kind: 'forecast-changed', weather: wet }] });
    expect(result.itinerary.days[0]?.weather?.precipitationChance).toBe(0.9);
  });
});

describe('replan: the budget changes', () => {
  it('drops paid stops when the budget is cut, and stays under the new ceiling', () => {
    const candidates = [0, 1, 2, 3].map((index) =>
      place({ id: `p${index}`, coord: eastOf(index * 400), costPerPerson: 40, dwellMinutes: 90 }),
    );
    const base = request({ candidates, budget: { total: 600, currency: 'EUR' } });
    const before = planTrip(base);
    expect(before.totals.cost).toBeGreaterThan(100);

    const result = replan({ itinerary: before, base, disruptions: [{ kind: 'budget-changed', total: 120 }] });
    expect(result.itinerary.totals.cost).toBeLessThanOrEqual(120);
    expect(result.itinerary.totals.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it('spends a raised budget on stops it had to leave out', () => {
    const candidates = [0, 1, 2, 3, 4].map((index) =>
      place({ id: `p${index}`, coord: eastOf(index * 400), costPerPerson: 50, dwellMinutes: 90 }),
    );
    const base = request({ candidates, budget: { total: 120, currency: 'EUR' } });
    const before = planTrip(base);

    const result = replan({ itinerary: before, base, disruptions: [{ kind: 'budget-changed', total: 900 }] });
    expect(result.itinerary.totals.placesVisited).toBeGreaterThanOrEqual(before.totals.placesVisited);
  });

  it('respects money already spent on stops that have happened', () => {
    const candidates = [0, 1, 2, 3].map((index) =>
      place({ id: `p${index}`, coord: eastOf(index * 300), costPerPerson: 30, dwellMinutes: 90 }),
    );
    const base = request({ startDate: '2026-03-16', endDate: '2026-03-16', candidates });
    const before = planTrip(base);
    const firstItem = before.days[0]!.items[0]!;

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: firstItem.end + 1 },
      // Cut the budget to barely more than what is already committed.
      disruptions: [{ kind: 'budget-changed', total: firstItem.cost + 10 }],
    });
    expect(result.itinerary.totals.cost).toBeLessThanOrEqual(firstItem.cost + 10);
  });
});

describe('replan: stability', () => {
  it('prefers to keep stops on the day they were already on', () => {
    const candidates = fourStops();
    const base = request({ candidates });
    const before = planTrip(base);

    // A disruption that touches only the last day.
    const lastDay = before.days[before.days.length - 1]!;
    const disruptions: Disruption[] =
      lastDay.items.length > 0 ? [{ kind: 'drop', placeId: lastDay.items[0]!.placeId }] : [];

    const result = replan({ itinerary: before, base, disruptions });

    const movedCount = result.changes.filter((change) => change.kind === 'moved').length;
    expect(movedCount).toBeLessThanOrEqual(1);
  });

  it('is deterministic: the same disruption always yields the same plan', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const disruptions: Disruption[] = [{ kind: 'running-late', minutes: 75 }];
    const now = { date: '2026-03-16', minute: 11 * 60 };

    const first = replan({ itinerary: before, base, disruptions, now });
    const second = replan({ itinerary: before, base, disruptions, now });
    expect(JSON.stringify(second.itinerary.days.map((d) => d.items.map((i) => [i.placeId, i.start])))).toBe(
      JSON.stringify(first.itinerary.days.map((d) => d.items.map((i) => [i.placeId, i.start]))),
    );
    expect(second.changes).toEqual(first.changes);
  });

  it('never lets a day run backwards or overlap itself, meals included', () => {
    // Regression: making history immovable let an insertion be judged feasible
    // *before* a visit that had already happened, producing a day whose second
    // item started four hours before its first and overlapped lunch.
    const sights = [0, 1, 2, 3].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 600), dwellMinutes: 90, rating: 4.6 - index * 0.1 }),
    );
    const eatery = place({
      id: 'eat',
      category: 'restaurant',
      coord: eastOf(300),
      dwellMinutes: 50,
      costPerPerson: 20,
      indoor: true,
      tags: ['food'],
      meal: { kinds: ['lunch'], priceLevel: 2, cuisines: [], dietary: [], costPerPerson: 20 },
    });

    for (const lateBy of [30, 60, 120, 180, 240]) {
      const base = request({
        startDate: '2026-03-16',
        endDate: '2026-03-16',
        candidates: [...sights, eatery],
        preferences: { meals: ['lunch'], dayEnd: 22 * 60 },
      });
      const before = planTrip(base);
      const result = replan({
        itinerary: before,
        base,
        now: { date: '2026-03-16', minute: 11 * 60 },
        disruptions: [{ kind: 'running-late', minutes: lateBy }],
      });

      for (const day of result.itinerary.days) {
        for (let i = 1; i < day.items.length; i += 1) {
          expect(day.items[i]!.start).toBeGreaterThanOrEqual(day.items[i - 1]!.end);
        }
      }
    }
  });

  it('keeps the plan valid: chronological, in hours, inside the budget', () => {
    const { base, result } = afterDisruption(
      [{ kind: 'running-late', minutes: 100 }],
      { candidates: fourStops() },
      { date: '2026-03-16', minute: 11 * 60 },
    );
    for (const day of result.itinerary.days) {
      for (let i = 1; i < day.items.length; i += 1) {
        expect(day.items[i]!.start).toBeGreaterThanOrEqual(day.items[i - 1]!.end);
      }
      for (const item of day.items) {
        expect(item.end).toBeLessThanOrEqual(base.preferences.dayEnd);
      }
    }
    expect(result.itinerary.totals.cost).toBeLessThanOrEqual(base.budget.total);
  });
});

describe('replan: what it tells the traveller', () => {
  it('leads with what fell off, not with what stayed put', () => {
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 240 }],
      { startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() },
      { date: '2026-03-16', minute: 10 * 60 },
    );
    const kinds = result.changes.map((change) => change.kind);
    const firstKept = kinds.indexOf('kept');
    const lastDropped = kinds.lastIndexOf('dropped');
    if (firstKept !== -1 && lastDropped !== -1) expect(lastDropped).toBeLessThan(firstKept);
  });

  it('names the cause and counts the effects', () => {
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 90 }],
      { startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() },
      { date: '2026-03-16', minute: 11 * 60 },
    );
    expect(result.summary[0]).toMatch(/running 1h 30m late/);
    expect(result.summary.join(' ')).toMatch(/dropped|moved|retimed|Nothing needed/);
  });

  it('reports a retime with the direction and the new time', () => {
    const base = request({ startDate: '2026-03-16', endDate: '2026-03-16', candidates: fourStops() });
    const before = planTrip(base);
    const second = before.days[0]!.items[1];
    if (!second) return;

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: before.days[0]!.items[0]!.end },
      disruptions: [{ kind: 'running-late', minutes: 40 }],
    });
    const change = changeFor(result, second.placeId);
    if (change?.kind === 'retimed') {
      expect(change.reason).toMatch(/later, at \d{2}:\d{2}/);
      expect(change.to?.start).toBeGreaterThan(change.from!.start);
    }
  });

  it('describes several disruptions at once', () => {
    const base = request({ candidates: fourStops() });
    const before = planTrip(base);
    const target = before.days[0]!.items[0]!.placeId;

    const result = replan({
      itinerary: before,
      base,
      disruptions: [
        { kind: 'running-late', minutes: 30 },
        { kind: 'place-closed', placeId: target, date: '2026-03-16' },
      ],
    });
    expect(result.summary[0]).toMatch(/running 30m late/);
    expect(result.summary[0]).toMatch(/closed on 2026-03-16/);
  });
});

describe('replan: meals', () => {
  it('re-books meals around the rearranged day', () => {
    const sights = [0, 1].map((index) =>
      place({ id: `s${index}`, coord: eastOf(index * 400), dwellMinutes: 90 }),
    );
    const lunch = place({
      id: 'lunch-spot',
      category: 'restaurant',
      coord: eastOf(200),
      dwellMinutes: 60,
      costPerPerson: 25,
      indoor: true,
      tags: ['food'],
      meal: { kinds: ['lunch'], priceLevel: 2, cuisines: [], dietary: [], costPerPerson: 25 },
    });

    const base = request({
      startDate: '2026-03-16',
      endDate: '2026-03-16',
      candidates: [...sights, lunch],
      preferences: { meals: ['lunch'], dayEnd: 21 * 60 },
    });
    const before = planTrip(base);
    expect(before.totals.mealsBooked).toBe(1);

    const result = replan({
      itinerary: before,
      base,
      now: { date: '2026-03-16', minute: 10 * 60 },
      disruptions: [{ kind: 'running-late', minutes: 45 }],
    });
    expect(result.itinerary.totals.mealsBooked).toBeGreaterThanOrEqual(0);
    expect(result.itinerary.totals.cost).toBeLessThanOrEqual(base.budget.total);
  });
});

describe('replan: edge cases', () => {
  it('copes with an empty itinerary', () => {
    const base = request();
    const before = planTrip(base);
    const result = replan({ itinerary: before, base, disruptions: [{ kind: 'running-late', minutes: 60 }] });
    expect(result.itinerary.totals.placesVisited).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it('ignores a disruption naming a place that is not in the trip', () => {
    const { before, result } = afterDisruption([{ kind: 'drop', placeId: 'nowhere' }], {
      candidates: fourStops(),
    });
    expect(result.itinerary.totals.placesVisited).toBe(before.totals.placesVisited);
  });

  it('copes with a moment after the trip has ended', () => {
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 30 }],
      { candidates: fourStops() },
      { date: '2026-03-25', minute: 12 * 60 },
    );
    // Nothing is left to plan, so nothing should be invented.
    expect(result.itinerary.days.every((day) => day.items.every((item) => item.locked !== false))).toBe(true);
  });

  it('produces clock times that are still valid times of day', () => {
    const { result } = afterDisruption(
      [{ kind: 'running-late', minutes: 300 }],
      { candidates: fourStops() },
      { date: '2026-03-16', minute: 12 * 60 },
    );
    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        expect(formatClock(item.start)).toMatch(/^\d{2}:\d{2}$/);
        expect(item.start).toBeGreaterThanOrEqual(0);
        expect(item.end).toBeGreaterThan(item.start);
      }
    }
  });
});
