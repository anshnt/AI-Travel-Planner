import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, normalizePreferences, partyCost, planTrip } from './planner.js';
import { formatClock, window } from './time.js';
import type { DailyWeather, HourlyWeather, Itinerary, OpeningHours, Place, PlanRequest, Preferences } from './types.js';

/** Central Barcelona-ish coordinates, close enough together to be walkable. */
const CENTRE = { lat: 41.3874, lon: 2.1686 };

/** Offsets a coordinate by roughly `meters` to the east, for predictable travel times. */
function eastOf(meters: number) {
  return { lat: CENTRE.lat, lon: CENTRE.lon + meters / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180)) };
}

const OPEN_DAILY: OpeningHours = { weekly: { 0: [window('09:00', '20:00')], 1: [window('09:00', '20:00')], 2: [window('09:00', '20:00')], 3: [window('09:00', '20:00')], 4: [window('09:00', '20:00')], 5: [window('09:00', '20:00')], 6: [window('09:00', '20:00')] } };

function place(overrides: Partial<Place> & Pick<Place, 'id'>): Place {
  return {
    name: overrides.id,
    category: 'landmark',
    coord: CENTRE,
    dwellMinutes: 60,
    costPerPerson: 0,
    rating: 4,
    tags: [],
    openingHours: OPEN_DAILY,
    indoor: false,
    ...overrides,
  };
}

function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  const preferences: Preferences = normalizePreferences({
    ...DEFAULT_PREFERENCES,
    travelers: 2,
    ...overrides.preferences,
  });
  return {
    destination: { name: 'Barcelona', center: CENTRE },
    startDate: '2026-03-16', // a Monday
    endDate: '2026-03-17',
    budget: { total: 400, currency: 'EUR' },
    candidates: [],
    ...overrides,
    preferences,
  };
}

/** Hourly forecast with the named hours wet and the rest dry. */
function hourlyRain(wetHours: readonly number[], risk = 0.85): HourlyWeather[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    tempC: 19,
    precipitationChance: wetHours.includes(hour) ? risk : 0.05,
    precipitationMm: wetHours.includes(hour) ? 3 : 0,
  }));
}

function forecast(date: string, wetHours: readonly number[], overrides: Partial<DailyWeather> = {}): DailyWeather {
  const wet = wetHours.length > 0;
  return {
    date,
    condition: wet ? 'rain' : 'clear',
    tempMinC: 15,
    tempMaxC: 23,
    precipitationChance: wet ? 0.85 : 0.05,
    precipitationMm: wet ? 6 : 0,
    windKph: 10,
    hourly: hourlyRain(wetHours),
    ...overrides,
  };
}

function scheduledIds(itinerary: Itinerary): string[] {
  return itinerary.days.flatMap((day) => day.items.map((item) => item.placeId));
}

function idsOnDay(itinerary: Itinerary, index: number): string[] {
  return (itinerary.days[index]?.items ?? []).map((item) => item.placeId);
}

describe('normalizePreferences', () => {
  it('lower-cases interest tags and clamps their weights', () => {
    const preferences = normalizePreferences({ interests: { Art: 4, FOOD: -9, history: 0.5 } });
    expect(preferences.interests).toEqual({ art: 1, food: -1, history: 0.5 });
  });

  it('keeps the day window at least an hour wide and the right way round', () => {
    const preferences = normalizePreferences({ dayStart: 18 * 60, dayEnd: 10 * 60 });
    expect(preferences.dayEnd - preferences.dayStart).toBeGreaterThanOrEqual(60);
  });

  it('never plans for less than one traveller', () => {
    expect(normalizePreferences({ travelers: 0 }).travelers).toBe(1);
  });

  it('falls back to walking and transit when no mode is given', () => {
    expect(normalizePreferences({ preferredModes: [] }).preferredModes).toEqual(['walk', 'transit']);
  });
});

describe('partyCost', () => {
  it('multiplies the per-person price by the party size', () => {
    expect(partyCost(place({ id: 'a', costPerPerson: 12.5 }), 3)).toBe(37.5);
    expect(partyCost(place({ id: 'a', costPerPerson: 0 }), 3)).toBe(0);
  });
});

describe('planTrip: shape and determinism', () => {
  it('produces one day per calendar date, inclusive', () => {
    const itinerary = planTrip(request({ startDate: '2026-03-16', endDate: '2026-03-19' }));
    expect(itinerary.days.map((day) => day.date)).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
    ]);
  });

  it('returns an empty but well-formed plan when there are no candidates', () => {
    const itinerary = planTrip(request());
    expect(scheduledIds(itinerary)).toEqual([]);
    expect(itinerary.totals.cost).toBe(0);
    expect(itinerary.totals.budgetRemaining).toBe(400);
    expect(itinerary.days[0]?.notes[0]).toMatch(/Nothing scheduled/);
  });

  it('plans the same trip identically every time', () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 400), rating: 4, tags: ['art'] }),
    );
    const base = request({ candidates, preferences: { interests: { art: 0.8 } } });
    const first = planTrip(base);
    const second = planTrip(base);
    expect(scheduledIds(second)).toEqual(scheduledIds(first));
    expect(second.score).toBe(first.score);
  });

  it('never schedules the same place twice, even if it appears twice in the pool', () => {
    const duplicate = place({ id: 'dup', tags: ['art'] });
    const itinerary = planTrip(
      request({ candidates: [duplicate, { ...duplicate }], preferences: { interests: { art: 1 } } }),
    );
    expect(scheduledIds(itinerary)).toEqual(['dup']);
  });

  it('leaves items in chronological order with no overlaps', () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 600), tags: ['art'] }),
    );
    const itinerary = planTrip(request({ candidates, preferences: { interests: { art: 1 } } }));
    for (const day of itinerary.days) {
      for (let i = 1; i < day.items.length; i += 1) {
        expect(day.items[i]!.start).toBeGreaterThanOrEqual(day.items[i - 1]!.end);
      }
    }
  });
});

describe('planTrip: opening hours', () => {
  it('refuses a place that is closed for the whole trip', () => {
    const closed = place({ id: 'closed', openingHours: { weekly: { 6: [window('10:00', '18:00')] } }, tags: ['art'] });
    const itinerary = planTrip(
      request({ startDate: '2026-03-16', endDate: '2026-03-17', candidates: [closed], preferences: { interests: { art: 1 } } }),
    );
    expect(scheduledIds(itinerary)).toEqual([]);
    expect(itinerary.rejected).toEqual([
      expect.objectContaining({ placeId: 'closed', reason: 'closed-on-all-days' }),
    ]);
  });

  it('moves a place to the only day it is actually open', () => {
    // Open Tuesdays only; the trip covers Monday and Tuesday.
    const tuesdayOnly = place({
      id: 'tuesday-only',
      openingHours: { weekly: { 2: [window('10:00', '18:00')] } },
      tags: ['art'],
    });
    const anyDay = place({ id: 'any-day', coord: eastOf(300), tags: ['art'] });

    const itinerary = planTrip(
      request({ candidates: [tuesdayOnly, anyDay], preferences: { interests: { art: 1 } } }),
    );
    expect(idsOnDay(itinerary, 1)).toContain('tuesday-only');
    expect(idsOnDay(itinerary, 0)).not.toContain('tuesday-only');
  });

  it('waits for a late opening rather than arriving at a locked door', () => {
    const lateOpener = place({
      id: 'late',
      openingHours: { weekly: { 1: [window('11:30', '18:00')] } },
      tags: ['art'],
    });
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates: [lateOpener], preferences: { interests: { art: 1 }, dayStart: 9 * 60 } }),
    );
    const item = itinerary.days[0]?.items[0];
    expect(item?.placeId).toBe('late');
    expect(formatClock(item!.start)).toBe('11:30');
  });

  it('schedules an early-closing place before one that stays open late', () => {
    // The market shuts at 11:00 and needs 90 minutes, so a 09:00 start is the
    // only way it fits at all: the rooftop has to give way.
    const market = place({
      id: 'market',
      category: 'market',
      openingHours: { weekly: { 1: [window('08:00', '11:00')] } },
      dwellMinutes: 90,
      tags: ['food'],
    });
    const rooftop = place({
      id: 'rooftop',
      category: 'viewpoint',
      coord: eastOf(500),
      openingHours: { weekly: { 1: [window('09:00', '23:00')] } },
      dwellMinutes: 60,
      tags: ['views'],
    });

    const itinerary = planTrip(
      request({
        endDate: '2026-03-16',
        candidates: [rooftop, market],
        preferences: { interests: { food: 1, views: 1 }, dayEnd: 22 * 60 },
      }),
    );
    expect(idsOnDay(itinerary, 0)).toEqual(['market', 'rooftop']);
  });

  it('explains a mid-day wait for a place that reopens later', () => {
    const morning = place({
      id: 'morning',
      openingHours: { weekly: { 1: [window('09:00', '10:30')] } },
      dwellMinutes: 60,
      tags: ['art'],
    });
    // Shut over the afternoon, so the second stop cannot start before 17:00.
    const evening = place({
      id: 'evening',
      coord: eastOf(200),
      openingHours: { weekly: { 1: [window('17:00', '20:00')] } },
      dwellMinutes: 45,
      tags: ['art'],
    });

    const itinerary = planTrip(
      request({
        endDate: '2026-03-16',
        candidates: [morning, evening],
        preferences: { interests: { art: 1 }, dayStart: 9 * 60, dayEnd: 20 * 60 },
      }),
    );
    expect(idsOnDay(itinerary, 0)).toEqual(['morning', 'evening']);
    expect(itinerary.days[0]?.notes.join(' ')).toMatch(/to spare before evening opens at 17:00/);
  });

  it('says when a visit could not have gone any later', () => {
    const closesEarly = place({
      id: 'closes-early',
      openingHours: { weekly: { 1: [window('09:00', '10:15')] } },
      dwellMinutes: 60,
      tags: ['art'],
    });
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates: [closesEarly], preferences: { interests: { art: 1 } } }),
    );
    expect(itinerary.days[0]?.notes.join(' ')).toMatch(/shuts at 10:15, so it could not go any later/);
  });

  it('does not recite the hours of a place whose hours constrained nothing', () => {
    const roomy = place({
      id: 'roomy',
      openingHours: { weekly: { 1: [window('08:00', '20:00')] } },
      dwellMinutes: 60,
      tags: ['art'],
    });
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates: [roomy], preferences: { interests: { art: 1 } } }),
    );
    expect(itinerary.days[0]?.notes.join(' ')).not.toMatch(/roomy/);
  });

  it('explains a late start in the day notes', () => {
    const lateOpener = place({
      id: 'late',
      openingHours: { weekly: { 1: [window('12:00', '18:00')] } },
      tags: ['art'],
    });
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates: [lateOpener], preferences: { interests: { art: 1 } } }),
    );
    expect(itinerary.days[0]?.notes.join(' ')).toMatch(/opens at 12:00/);
  });
});

describe('planTrip: budget', () => {
  it('stops adding paid places once the budget is exhausted', () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 200), costPerPerson: 40, tags: ['art'] }),
    );
    const itinerary = planTrip(
      request({ budget: { total: 120, currency: 'EUR' }, candidates, preferences: { interests: { art: 1 }, travelers: 1 } }),
    );
    expect(itinerary.totals.cost).toBeLessThanOrEqual(120);
    expect(itinerary.totals.budgetRemaining).toBeGreaterThanOrEqual(0);
    expect(scheduledIds(itinerary).length).toBeLessThan(6);
  });

  it('charges tickets per traveller', () => {
    const paid = place({ id: 'paid', costPerPerson: 25, tags: ['art'] });
    const solo = planTrip(request({ candidates: [paid], preferences: { interests: { art: 1 }, travelers: 1 } }));
    const four = planTrip(request({ candidates: [paid], preferences: { interests: { art: 1 }, travelers: 4 } }));
    expect(solo.days.flatMap((d) => d.items)[0]?.cost).toBe(25);
    expect(four.days.flatMap((d) => d.items)[0]?.cost).toBe(100);
  });

  it('still schedules free places when the money has run out', () => {
    const expensive = place({ id: 'expensive', costPerPerson: 100, tags: ['art'] });
    const free = place({ id: 'free', coord: eastOf(400), costPerPerson: 0, tags: ['art'] });
    const itinerary = planTrip(
      request({
        budget: { total: 100, currency: 'EUR' },
        candidates: [expensive, free],
        preferences: { interests: { art: 1 }, travelers: 1 },
      }),
    );
    expect(scheduledIds(itinerary)).toContain('free');
  });

  it('reports over-budget candidates as such', () => {
    const itinerary = planTrip(
      request({
        budget: { total: 10, currency: 'EUR' },
        candidates: [place({ id: 'pricey', costPerPerson: 200, tags: ['art'] })],
        preferences: { interests: { art: 1 }, travelers: 1 },
      }),
    );
    expect(itinerary.rejected).toEqual([expect.objectContaining({ placeId: 'pricey', reason: 'over-budget' })]);
  });
});

describe('planTrip: preferences', () => {
  it('drops categories the traveller asked to avoid', () => {
    const itinerary = planTrip(
      request({
        candidates: [place({ id: 'club', category: 'nightlife', tags: ['music'] })],
        preferences: { interests: { music: 1 }, avoidCategories: ['nightlife'] },
      }),
    );
    expect(scheduledIds(itinerary)).toEqual([]);
    expect(itinerary.rejected[0]).toMatchObject({ placeId: 'club', reason: 'avoided-category' });
  });

  it('honours a must-see even when the traveller avoids its category', () => {
    const itinerary = planTrip(
      request({
        candidates: [place({ id: 'club', category: 'nightlife', tags: ['music'] })],
        preferences: { avoidCategories: ['nightlife'], mustSeeIds: ['club'] },
      }),
    );
    expect(scheduledIds(itinerary)).toEqual(['club']);
  });

  it('prefers a lower-rated place the traveller actually wants over a famous one they do not', () => {
    const belovedNiche = place({ id: 'niche', rating: 3.4, tags: ['textiles'] });
    const famousIrrelevant = place({ id: 'famous', coord: eastOf(300), rating: 4.9, tags: ['nightlife'] });

    // A single day with room for exactly one 60-minute stop, so the two
    // candidates compete head to head.
    const itinerary = planTrip(
      request({
        endDate: '2026-03-16',
        candidates: [famousIrrelevant, belovedNiche],
        preferences: {
          interests: { textiles: 1, nightlife: -0.5 },
          pace: 'relaxed',
          dayStart: 9 * 60,
          dayEnd: 10 * 60 + 30,
        },
      }),
    );
    expect(scheduledIds(itinerary)).toEqual(['niche']);
  });

  it('keeps both when there is room, most wanted first', () => {
    const belovedNiche = place({ id: 'niche', rating: 3.4, tags: ['textiles'] });
    const famousIrrelevant = place({ id: 'famous', coord: eastOf(300), rating: 4.9, tags: ['nightlife'] });
    const itinerary = planTrip(
      request({
        endDate: '2026-03-16',
        candidates: [famousIrrelevant, belovedNiche],
        preferences: { interests: { textiles: 1, nightlife: -0.5 }, pace: 'relaxed' },
      }),
    );
    expect(idsOnDay(itinerary, 0)).toEqual(['niche', 'famous']);
  });

  it('refuses a place the traveller strongly dislikes', () => {
    const itinerary = planTrip(
      request({
        candidates: [place({ id: 'hated', tags: ['queues'] })],
        preferences: { interests: { queues: -1 } },
      }),
    );
    expect(itinerary.rejected[0]).toMatchObject({ placeId: 'hated', reason: 'disliked' });
  });

  it('respects the pace ceiling on stops per day', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 150), dwellMinutes: 45, tags: ['art'] }),
    );
    const relaxed = planTrip(
      request({ endDate: '2026-03-16', candidates, preferences: { interests: { art: 1 }, pace: 'relaxed' } }),
    );
    const packed = planTrip(
      request({ endDate: '2026-03-16', candidates, preferences: { interests: { art: 1 }, pace: 'packed' } }),
    );
    expect(idsOnDay(relaxed, 0).length).toBeLessThanOrEqual(3);
    expect(idsOnDay(packed, 0).length).toBeGreaterThan(idsOnDay(relaxed, 0).length);
  });

  it('keeps everything inside the traveller day window', () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 200), tags: ['art'] }),
    );
    const itinerary = planTrip(
      request({ candidates, preferences: { interests: { art: 1 }, dayStart: 10 * 60, dayEnd: 16 * 60 } }),
    );
    for (const day of itinerary.days) {
      for (const item of day.items) {
        expect(item.start).toBeGreaterThanOrEqual(10 * 60);
        expect(item.end).toBeLessThanOrEqual(16 * 60);
      }
    }
  });
});

describe('planTrip: geography and travel', () => {
  it('groups nearby places together rather than criss-crossing the city', () => {
    // Two clusters 12 km apart, three places each, over two days.
    const near = [0, 1, 2].map((index) => place({ id: `near${index}`, coord: eastOf(index * 250), tags: ['art'] }));
    const far = [0, 1, 2].map((index) =>
      place({ id: `far${index}`, coord: eastOf(12_000 + index * 250), tags: ['art'] }),
    );

    const itinerary = planTrip(
      request({ candidates: [...near, ...far], preferences: { interests: { art: 1 }, pace: 'relaxed' } }),
    );

    for (const day of itinerary.days) {
      const ids = day.items.map((item) => item.placeId);
      if (ids.length < 2) continue;
      const clusters = new Set(ids.map((id) => (id.startsWith('near') ? 'near' : 'far')));
      expect(clusters.size).toBe(1);
    }
  });

  it('records a travel leg for every item and a return to base', () => {
    const candidates = [0, 1].map((index) => place({ id: `p${index}`, coord: eastOf(index * 900), tags: ['art'] }));
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates, preferences: { interests: { art: 1 } } }),
    );
    const day = itinerary.days[0]!;
    expect(day.items.every((item) => item.arrival !== undefined)).toBe(true);
    expect(day.returnToBase?.toPlaceId).toBe('__origin__');
    expect(day.totals.travelMinutes).toBeGreaterThan(0);
  });

  it('starts and ends the day at the lodging when one is given', () => {
    const lodging = place({ id: 'hotel', category: 'lodging', coord: eastOf(5000) });
    const candidates = [place({ id: 'p0', coord: eastOf(5200), tags: ['art'] })];
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates, lodging, preferences: { interests: { art: 1 } } }),
    );
    expect(itinerary.days[0]?.items[0]?.arrival?.fromPlaceId).toBe('hotel');
    expect(itinerary.days[0]?.returnToBase?.toPlaceId).toBe('hotel');
    expect(itinerary.days[0]?.notes.join(' ')).toMatch(/Starts and ends at hotel/);
  });

  it('does not schedule the lodging as a sightseeing stop', () => {
    const lodging = place({ id: 'hotel', category: 'lodging', tags: ['art'] });
    const itinerary = planTrip(
      request({ candidates: [lodging], lodging, preferences: { interests: { art: 1 } } }),
    );
    expect(scheduledIds(itinerary)).toEqual([]);
  });

  it('leaves restaurants to the meal planner', () => {
    const bistro = place({ id: 'bistro', category: 'restaurant', tags: ['food'] });
    const museum = place({ id: 'museum', category: 'museum', coord: eastOf(400), tags: ['art'] });
    const itinerary = planTrip(
      request({ candidates: [bistro, museum], preferences: { interests: { food: 1, art: 1 } } }),
    );
    expect(scheduledIds(itinerary)).toEqual(['museum']);
  });
});

describe('planTrip: the budget is a hard ceiling', () => {
  // The trip total includes travel fares, and every day ends with a journey back
  // to base. Budgeting the outbound legs but not the return one is exactly the
  // kind of slow leak that puts a plan over budget by a few euros a day.
  const spendy = Array.from({ length: 14 }, (_, index) =>
    place({
      id: `p${index}`,
      coord: eastOf(index * 1400),
      costPerPerson: 6 + (index % 5) * 7,
      dwellMinutes: 45 + (index % 3) * 20,
      tags: ['art'],
    }),
  );

  for (const total of [40, 90, 180, 400]) {
    it(`never spends more than the ${total} it was given`, () => {
      const itinerary = planTrip(
        request({
          startDate: '2026-03-16',
          endDate: '2026-03-19',
          budget: { total, currency: 'EUR' },
          candidates: spendy,
          preferences: { interests: { art: 1 }, travelers: 2 },
        }),
      );
      expect(itinerary.totals.cost).toBeLessThanOrEqual(total);
      expect(itinerary.totals.budgetRemaining).toBeGreaterThanOrEqual(0);
    });
  }

  it('counts the journey back to base in the day cost', () => {
    const lodging = place({ id: 'hotel', category: 'lodging', coord: CENTRE });
    const faraway = place({ id: 'faraway', coord: eastOf(9000), costPerPerson: 0, tags: ['art'] });
    const itinerary = planTrip(
      request({
        endDate: '2026-03-16',
        candidates: [faraway],
        lodging,
        preferences: { interests: { art: 1 } },
      }),
    );
    const day = itinerary.days[0]!;
    const outbound = day.items[0]!.arrival!.cost;
    const home = day.returnToBase!.cost;
    expect(home).toBeGreaterThan(0);
    expect(day.totals.cost).toBeCloseTo(outbound + home, 2);
  });
});

describe('planTrip: weather', () => {
  const park = () => place({ id: 'park', category: 'park', indoor: false, dwellMinutes: 90, tags: ['parks'] });
  const gallery = () =>
    place({
      id: 'gallery',
      category: 'gallery',
      coord: eastOf(400),
      indoor: true,
      dwellMinutes: 90,
      tags: ['art'],
    });

  const oneDay = (weather: DailyWeather[] | undefined) =>
    planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-16',
        candidates: [park(), gallery()],
        ...(weather ? { weather } : {}),
        preferences: {
          interests: { parks: 0.8, art: 0.8 },
          dayStart: 9 * 60,
          dayEnd: 18 * 60,
          pace: 'balanced',
        },
      }),
    );

  it('puts the indoor stop in the wet hours and the outdoor one in the dry hours', () => {
    // Dry morning, wet afternoon: park first, gallery second.
    const wetAfternoon = oneDay([forecast('2026-03-16', [13, 14, 15, 16, 17])]);
    expect(idsOnDay(wetAfternoon, 0)).toEqual(['park', 'gallery']);
  });

  it('reverses that order when the rain comes in the morning instead', () => {
    const wetMorning = oneDay([forecast('2026-03-16', [9, 10, 11, 12])]);
    expect(idsOnDay(wetMorning, 0)).toEqual(['gallery', 'park']);
  });

  it('leaves the order to geography and hours when the day is dry throughout', () => {
    const dry = oneDay([forecast('2026-03-16', [])]);
    const blind = oneDay(undefined);
    expect(idsOnDay(dry, 0)).toEqual(idsOnDay(blind, 0));
  });

  it('honours ignoreWeather even when a forecast is supplied', () => {
    const base = request({
      startDate: '2026-03-16',
      endDate: '2026-03-16',
      candidates: [park(), gallery()],
      weather: [forecast('2026-03-16', [9, 10, 11, 12])],
      preferences: { interests: { parks: 0.8, art: 0.8 }, dayStart: 9 * 60, dayEnd: 18 * 60 },
    });
    expect(idsOnDay(planTrip(base, { ignoreWeather: true }), 0)).toEqual(
      idsOnDay(planTrip({ ...base, weather: [] }), 0),
    );
  });

  it('moves an outdoor stop to the drier of two days', () => {
    // Monday is a washout; Tuesday is clear. The park should land on Tuesday.
    const itinerary = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-17',
        candidates: [park()],
        weather: [
          forecast('2026-03-16', [9, 10, 11, 12, 13, 14, 15, 16, 17]),
          forecast('2026-03-17', []),
        ],
        preferences: { interests: { parks: 0.9 }, dayStart: 9 * 60, dayEnd: 18 * 60 },
      }),
    );
    expect(idsOnDay(itinerary, 1)).toEqual(['park']);
    expect(idsOnDay(itinerary, 0)).toEqual([]);
  });

  it('does not abandon a strongly wanted outdoor stop just because it rains', () => {
    const itinerary = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-16',
        candidates: [park()],
        weather: [forecast('2026-03-16', [9, 10, 11, 12, 13, 14, 15, 16, 17])],
        preferences: { interests: { parks: 1 }, dayStart: 9 * 60, dayEnd: 18 * 60 },
      }),
    );
    expect(idsOnDay(itinerary, 0)).toEqual(['park']);
  });

  it('attaches a caution to a stop scheduled through rain, and none when dry', () => {
    const wet = oneDay([forecast('2026-03-16', [9, 10, 11, 12, 13, 14, 15, 16, 17])]);
    const parkItem = wet.days[0]!.items.find((item) => item.placeId === 'park');
    expect(parkItem?.cautions.join(' ')).toMatch(/outdoors with a 85% chance of rain/);

    const dry = oneDay([forecast('2026-03-16', [])]);
    expect(dry.days[0]!.items.every((item) => item.cautions.length === 0)).toBe(true);
  });

  it('says in the day notes whether the plan dodged the rain or ran into it', () => {
    const dodged = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-16',
        candidates: [gallery()],
        weather: [forecast('2026-03-16', [13, 14, 15])],
        preferences: { interests: { art: 1 }, dayStart: 12 * 60, dayEnd: 18 * 60 },
      }),
    );
    expect(dodged.days[0]?.notes.join(' ')).toMatch(/Rain likely 13:00 to 16:00 \(85%\): gallery sits under cover/);

    const caught = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-16',
        candidates: [park()],
        weather: [forecast('2026-03-16', [9, 10, 11, 12, 13, 14, 15, 16, 17])],
        preferences: { interests: { parks: 1 }, dayStart: 9 * 60, dayEnd: 18 * 60 },
      }),
    );
    expect(caught.days[0]?.notes.join(' ')).toMatch(/park is outdoors. Take a coat/);
  });

  it('still plans normally for days the forecast does not cover', () => {
    const itinerary = planTrip(
      request({
        startDate: '2026-03-16',
        endDate: '2026-03-17',
        candidates: [park(), gallery()],
        weather: [forecast('2026-03-16', [9, 10, 11])],
        preferences: { interests: { parks: 0.8, art: 0.8 } },
      }),
    );
    expect(scheduledIds(itinerary).sort()).toEqual(['gallery', 'park']);
    expect(itinerary.days[1]?.weather).toBeUndefined();
  });
});

describe('planTrip: totals', () => {
  it('adds day totals up to the trip totals', () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      place({ id: `p${index}`, coord: eastOf(index * 700), costPerPerson: 8, tags: ['art'] }),
    );
    const itinerary = planTrip(request({ candidates, preferences: { interests: { art: 1 } } }));

    const summed = itinerary.days.reduce(
      (acc, day) => ({
        cost: Math.round((acc.cost + day.totals.cost) * 100) / 100,
        travelMinutes: acc.travelMinutes + day.totals.travelMinutes,
        activeMinutes: acc.activeMinutes + day.totals.activeMinutes,
      }),
      { cost: 0, travelMinutes: 0, activeMinutes: 0 },
    );

    expect(itinerary.totals.cost).toBeCloseTo(summed.cost, 2);
    expect(itinerary.totals.travelMinutes).toBe(summed.travelMinutes);
    expect(itinerary.totals.activeMinutes).toBe(summed.activeMinutes);
    expect(itinerary.totals.placesVisited).toBe(scheduledIds(itinerary).length);
  });

  it('counts active minutes as time at places, not time travelling', () => {
    const candidates = [place({ id: 'p0', dwellMinutes: 90, tags: ['art'] })];
    const itinerary = planTrip(
      request({ endDate: '2026-03-16', candidates, preferences: { interests: { art: 1 } } }),
    );
    expect(itinerary.days[0]?.totals.activeMinutes).toBe(90);
  });
});
