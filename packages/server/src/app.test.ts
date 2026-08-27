import type { Itinerary } from '@atp/core';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { DESTINATIONS } from './data/destinations.js';
import { SyntheticWeatherProvider } from './providers/weather.js';

let app: Express;

/**
 * Drives the Express app through `fetch` against a real ephemeral listener.
 * That exercises the same JSON serialisation path a browser client uses, which
 * is where response bugs actually live.
 */
async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port assigned');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const basePlan = {
  destinationId: 'barcelona',
  startDate: '2026-05-11', // Monday
  endDate: '2026-05-13',
  budgetTotal: 500,
  preferences: {
    interests: { architecture: 1, 'art-nouveau': 0.9, food: 0.7, views: 0.6 },
    pace: 'balanced' as const,
    travelers: 2,
  },
};

beforeAll(() => {
  // The climate model explicitly: these tests assert on exact plans, so the
  // weather has to be the same every run -- and a unit test that reaches for a
  // live forecast is a unit test that fails on a train.
  app = createApp({ weather: new SyntheticWeatherProvider() });
});

describe('GET /api/health', () => {
  it('reports the destination count and the weather provider in use', async () => {
    const { status, json } = await call('GET', '/api/health');
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'ok', destinations: DESTINATIONS.length, weatherProvider: 'synthetic' });
  });
});

describe('GET /api/destinations', () => {
  it('lists destinations without shipping every place', async () => {
    const { status, json } = await call('GET', '/api/destinations');
    expect(status).toBe(200);
    expect(json.destinations.map((d: { id: string }) => d.id)).toEqual(['barcelona', 'kyoto', 'lisbon']);
    expect(json.destinations[0]).not.toHaveProperty('places');
    expect(json.destinations[0].interests.length).toBeGreaterThan(3);
  });

  it('returns one destination in full', async () => {
    const { status, json } = await call('GET', '/api/destinations/kyoto');
    expect(status).toBe(200);
    expect(json.destination.currency).toBe('JPY');
    expect(json.destination.places.length).toBeGreaterThan(10);
  });

  it('404s an unknown destination', async () => {
    const { status, json } = await call('GET', '/api/destinations/atlantis');
    expect(status).toBe(404);
    expect(json.error).toMatch(/Unknown destination/);
  });
});

describe('GET /api/destinations/:id/forecast', () => {
  it('returns one entry per day in range', async () => {
    const { status, json } = await call(
      'GET',
      '/api/destinations/lisbon/forecast?startDate=2026-05-11&endDate=2026-05-14',
    );
    expect(status).toBe(200);
    expect(json.forecast.map((d: { date: string }) => d.date)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
    ]);
    expect(json.forecast[0].hourly).toHaveLength(24);
  });

  it('is deterministic for the same place and date', async () => {
    const first = await call('GET', '/api/destinations/lisbon/forecast?startDate=2026-05-11&endDate=2026-05-11');
    const second = await call('GET', '/api/destinations/lisbon/forecast?startDate=2026-05-11&endDate=2026-05-11');
    expect(second.json.forecast).toEqual(first.json.forecast);
  });

  it('rejects a missing or backwards range', async () => {
    expect((await call('GET', '/api/destinations/lisbon/forecast')).status).toBe(400);
    expect(
      (await call('GET', '/api/destinations/lisbon/forecast?startDate=2026-05-14&endDate=2026-05-11')).status,
    ).toBe(400);
  });
});

describe('POST /api/plan', () => {
  it('plans a real trip end to end', async () => {
    const { status, json } = await call('POST', '/api/plan', basePlan);
    expect(status).toBe(200);

    const itinerary: Itinerary = json.itinerary;
    expect(itinerary.days).toHaveLength(3);
    expect(itinerary.currency).toBe('EUR');
    expect(itinerary.totals.placesVisited).toBeGreaterThan(4);
    expect(itinerary.totals.cost).toBeLessThanOrEqual(500);

    // Every scheduled item should carry the data the UI needs to draw it.
    for (const day of itinerary.days) {
      expect(day.weather?.date).toBe(day.date);
      for (const item of day.items) {
        expect(item.place.coord.lat).toBeTypeOf('number');
        expect(item.end).toBeGreaterThan(item.start);
        expect(item.arrival).toBeDefined();
      }
    }
  });

  it('keeps Monday-closed museums off the Monday', async () => {
    const { json } = await call('POST', '/api/plan', {
      ...basePlan,
      preferences: { ...basePlan.preferences, interests: { art: 1, museums: 1 } },
    });
    const monday = json.itinerary.days.find((day: { date: string }) => day.date === '2026-05-11');
    const closedOnMondays = ['bcn-picasso-museum', 'bcn-mnac', 'bcn-miro'];
    for (const item of monday.items) {
      expect(closedOnMondays).not.toContain(item.placeId);
    }
  });

  it('respects a tight budget', async () => {
    const { json } = await call('POST', '/api/plan', { ...basePlan, budgetTotal: 60 });
    expect(json.itinerary.totals.cost).toBeLessThanOrEqual(60);
    expect(json.itinerary.totals.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it('plans a yen trip without mistaking the price scale', async () => {
    const { json } = await call('POST', '/api/plan', {
      destinationId: 'kyoto',
      startDate: '2026-05-11',
      endDate: '2026-05-13',
      budgetTotal: 60_000,
      preferences: { interests: { temples: 1, gardens: 0.8 }, travelers: 2 },
    });
    expect(json.itinerary.currency).toBe('JPY');
    expect(json.itinerary.totals.placesVisited).toBeGreaterThan(3);
    expect(json.itinerary.totals.cost).toBeLessThanOrEqual(60_000);
  });

  it('narrows the pool to the places the traveller kept', async () => {
    const keep = ['bcn-sagrada-familia', 'bcn-park-guell'];
    const { json } = await call('POST', '/api/plan', { ...basePlan, includePlaceIds: keep });
    const scheduled = json.itinerary.days.flatMap((day: { items: { placeId: string }[] }) =>
      day.items.map((item) => item.placeId),
    );
    expect(scheduled.sort()).toEqual([...keep].sort());
  });

  it('anchors days to the chosen lodging', async () => {
    const { json } = await call('POST', '/api/plan', { ...basePlan, lodgingPlaceId: 'bcn-gothic-quarter' });
    const firstDay = json.itinerary.days[0];
    expect(firstDay.items[0].arrival.fromPlaceId).toBe('bcn-gothic-quarter');
    expect(firstDay.returnToBase.toPlaceId).toBe('bcn-gothic-quarter');
  });

  it('applies preference defaults when none are sent', async () => {
    const { status, json } = await call('POST', '/api/plan', {
      destinationId: 'lisbon',
      startDate: '2026-05-11',
      endDate: '2026-05-12',
      budgetTotal: 200,
    });
    expect(status).toBe(200);
    expect(json.itinerary.days).toHaveLength(2);
  });

  it('reports validation problems field by field', async () => {
    const { status, json } = await call('POST', '/api/plan', {
      destinationId: 'barcelona',
      startDate: '11-05-2026',
      endDate: '2026-05-13',
      budgetTotal: -5,
    });
    expect(status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.issues.map((issue: { path: string }) => issue.path)).toContain('startDate');
    expect(json.issues.map((issue: { path: string }) => issue.path)).toContain('budgetTotal');
  });

  it('rejects a backwards date range', async () => {
    const { status, json } = await call('POST', '/api/plan', {
      ...basePlan,
      startDate: '2026-05-13',
      endDate: '2026-05-11',
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json.issues)).toMatch(/endDate must not precede startDate/);
  });

  it('rejects an implausibly long trip rather than grinding on it', async () => {
    const { status } = await call('POST', '/api/plan', {
      ...basePlan,
      startDate: '2026-05-01',
      endDate: '2026-12-01',
    });
    expect(status).toBe(400);
  });

  it('404s an unknown destination and 400s an unknown lodging', async () => {
    expect((await call('POST', '/api/plan', { ...basePlan, destinationId: 'atlantis' })).status).toBe(404);
    expect((await call('POST', '/api/plan', { ...basePlan, lodgingPlaceId: 'nowhere' })).status).toBe(400);
  });
});

describe('POST /api/plan: meals', () => {
  it('books lunch and dinner by default', async () => {
    const { json } = await call('POST', '/api/plan', basePlan);
    const itinerary: Itinerary = json.itinerary;
    expect(itinerary.totals.mealsBooked).toBeGreaterThan(0);
    expect(itinerary.totals.mealCost).toBeGreaterThan(0);

    const meals = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'meal'));
    for (const meal of meals) {
      expect(['breakfast', 'lunch', 'dinner']).toContain(meal.mealKind);
      expect(meal.place.meal).toBeDefined();
    }
  });

  it('books nothing when meals is an empty list', async () => {
    const { json } = await call('POST', '/api/plan', {
      ...basePlan,
      preferences: { ...basePlan.preferences, meals: [] },
    });
    expect(json.itinerary.totals.mealsBooked).toBe(0);
    expect(json.itinerary.totals.mealCost).toBe(0);
  });

  it('only books places that meet a dietary requirement', async () => {
    const { json } = await call('POST', '/api/plan', {
      ...basePlan,
      preferences: { ...basePlan.preferences, meals: ['lunch', 'dinner'], dietary: ['vegan'] },
    });
    const meals = json.itinerary.days.flatMap((day: { items: any[] }) =>
      day.items.filter((item) => item.kind === 'meal'),
    );
    for (const meal of meals) {
      expect(meal.place.meal.dietary).toContain('vegan');
    }
  });

  it('accepts a later dinner window without restating the others', async () => {
    const { status, json } = await call('POST', '/api/plan', {
      ...basePlan,
      preferences: {
        ...basePlan.preferences,
        meals: ['dinner'],
        mealWindows: { dinner: { start: '21:00', end: '22:30' } },
        dayEnd: '23:30',
      },
    });
    expect(status).toBe(200);
    const dinners = json.itinerary.days.flatMap((day: { items: any[] }) =>
      day.items.filter((item) => item.mealKind === 'dinner'),
    );
    expect(dinners.length).toBeGreaterThan(0);
    for (const dinner of dinners) expect(dinner.start).toBeGreaterThanOrEqual(21 * 60);
  });

  it('rejects a backwards meal window', async () => {
    const { status } = await call('POST', '/api/plan', {
      ...basePlan,
      preferences: { ...basePlan.preferences, mealWindows: { lunch: { start: '14:00', end: '12:00' } } },
    });
    expect(status).toBe(400);
  });

  it('honours an explicit food share and still respects the total', async () => {
    const { json } = await call('POST', '/api/plan', { ...basePlan, budgetTotal: 400, foodShare: 0.6 });
    expect(json.itinerary.totals.cost).toBeLessThanOrEqual(400);
    expect(json.itinerary.totals.mealsBooked).toBeGreaterThan(0);
  });

  it('rejects a food share outside 0 to 1', async () => {
    expect((await call('POST', '/api/plan', { ...basePlan, foodShare: 1.5 })).status).toBe(400);
  });

  it('keeps day totals adding up with meals in the plan', async () => {
    const { json } = await call('POST', '/api/plan', basePlan);
    const itinerary: Itinerary = json.itinerary;
    const summedFood = itinerary.days.reduce((sum, day) => sum + day.totals.mealCost, 0);
    expect(itinerary.totals.mealCost).toBeCloseTo(summedFood, 2);
    expect(itinerary.totals.mealCost).toBeLessThanOrEqual(itinerary.totals.cost);
  });
});

function hasPlace(itinerary: Itinerary, date: string, placeId: string): boolean {
  return itinerary.days.some((day) => day.date === date && day.items.some((item) => item.placeId === placeId));
}

describe('POST /api/replan', () => {
  /** Plans a trip, then re-plans it through the API the way a client would. */
  async function planThenReplan(body: Record<string, unknown>) {
    const first = await call('POST', '/api/plan', basePlan);
    const itinerary: Itinerary = first.json.itinerary;
    const scheduled = itinerary.days.flatMap((day) =>
      day.items.map((item) => ({
        date: day.date,
        placeId: item.placeId,
        start: item.start,
        kind: item.kind,
        ...(item.mealKind ? { mealKind: item.mealKind } : {}),
      })),
    );
    const second = await call('POST', '/api/replan', { ...basePlan, scheduled, ...body });
    return { before: itinerary, scheduled, status: second.status, json: second.json };
  }

  it('returns the new plan, the changes and a summary', async () => {
    const { status, json } = await planThenReplan({
      now: { date: '2026-05-11', minute: '11:00' },
      disruptions: [{ kind: 'running-late', minutes: 90 }],
    });
    expect(status).toBe(200);
    expect(json.itinerary.days).toHaveLength(3);
    expect(Array.isArray(json.changes)).toBe(true);
    expect(json.summary.join(' ')).toMatch(/running 1h 30m late/);
    expect(Array.isArray(json.pinned)).toBe(true);
  });

  it('leaves an undisrupted plan alone', async () => {
    const { before, status, json } = await planThenReplan({ disruptions: [] });
    expect(status).toBe(200);
    const scheduledAfter = json.itinerary.days.flatMap((day: { items: { placeId: string }[] }) =>
      day.items.map((item) => item.placeId),
    );
    const scheduledBefore = before.days.flatMap((day) => day.items.map((item) => item.placeId));
    expect(scheduledAfter).toEqual(scheduledBefore);
  });

  it('drops a stop reported closed and says so', async () => {
    const { before, json } = await planThenReplan({
      disruptions: [{ kind: 'place-closed', placeId: 'bcn-sagrada-familia' }],
    });
    const wasScheduled = before.days.some((day) =>
      day.items.some((item) => item.placeId === 'bcn-sagrada-familia'),
    );
    const stillScheduled = json.itinerary.days.some((day: { items: { placeId: string }[] }) =>
      day.items.some((item) => item.placeId === 'bcn-sagrada-familia'),
    );
    expect(stillScheduled).toBe(false);
    if (wasScheduled) {
      const change = json.changes.find((c: { placeId: string }) => c.placeId === 'bcn-sagrada-familia');
      expect(change).toMatchObject({ kind: 'dropped', reason: 'reported as closed' });
    }
  });

  it('honours a pin across the round trip', async () => {
    const first = await call('POST', '/api/plan', basePlan);
    const itinerary: Itinerary = first.json.itinerary;
    const target = itinerary.days[0]!.items[0]!;
    const scheduled = itinerary.days.flatMap((day) =>
      day.items.map((item) => ({ date: day.date, placeId: item.placeId, start: item.start, kind: item.kind })),
    );

    const { json } = await call('POST', '/api/replan', {
      ...basePlan,
      scheduled,
      disruptions: [{ kind: 'pin', placeId: target.placeId }],
    });
    expect(json.pinned).toContain(target.placeId);
  });

  it('keeps the new plan inside a reduced budget', async () => {
    const { json } = await planThenReplan({ disruptions: [{ kind: 'budget-changed', total: 80 }] });
    expect(json.itinerary.totals.cost).toBeLessThanOrEqual(80);
  });

  it('accepts clock strings for the current moment', async () => {
    const { status } = await planThenReplan({
      now: { date: '2026-05-12', minute: '14:30' },
      disruptions: [{ kind: 'running-late', minutes: 20 }],
    });
    expect(status).toBe(200);
  });

  it('rejects an unknown place in the schedule rather than silently ignoring it', async () => {
    const { status, json } = await call('POST', '/api/replan', {
      ...basePlan,
      scheduled: [{ date: '2026-05-11', placeId: 'not-a-place', start: 600 }],
      disruptions: [],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Unknown placeId/);
    expect(json.ids).toEqual(['not-a-place']);
  });

  it('rejects a malformed disruption', async () => {
    const { status } = await call('POST', '/api/replan', {
      ...basePlan,
      scheduled: [],
      disruptions: [{ kind: 'teleport', placeId: 'x' }],
    });
    expect(status).toBe(400);
  });

  it('rejects a negative lateness', async () => {
    const { status } = await call('POST', '/api/replan', {
      ...basePlan,
      scheduled: [],
      disruptions: [{ kind: 'running-late', minutes: -30 }],
    });
    expect(status).toBe(400);
  });

  it('404s an unknown destination', async () => {
    const { status } = await call('POST', '/api/replan', {
      ...basePlan,
      destinationId: 'atlantis',
      scheduled: [],
      disruptions: [],
    });
    expect(status).toBe(404);
  });

  it('moves a stop to a requested day, clearing space if it has to', async () => {
    // A roomy budget, so the move is not blocked by money.
    const roomy = { ...basePlan, budgetTotal: 1200 };
    const first = await call('POST', '/api/plan', roomy);
    const itinerary: Itinerary = first.json.itinerary;
    const target = itinerary.days[0]!.items.find((item) => item.kind === 'activity')!;
    const scheduled = itinerary.days.flatMap((day) =>
      day.items.map((item) => ({ date: day.date, placeId: item.placeId, start: item.start, kind: item.kind })),
    );

    const { json } = await call('POST', '/api/replan', {
      ...roomy,
      scheduled,
      disruptions: [{ kind: 'move', placeId: target.placeId, toDate: '2026-05-13' }],
    });

    const landedOn = json.itinerary.days.find((day: { items: { placeId: string }[] }) =>
      day.items.some((item) => item.placeId === target.placeId),
    );
    expect(landedOn?.date ?? 'dropped').toBe('2026-05-13');
  });

  it('says it is the money, not the room, when a move cannot be afforded', async () => {
    // This trip already spends almost all of a 500 budget.
    const first = await call('POST', '/api/plan', basePlan);
    const itinerary: Itinerary = first.json.itinerary;
    const dear = itinerary.days
      .flatMap((day) => day.items)
      .filter((item) => item.kind === 'activity')
      .reduce((most, item) => (item.cost > most.cost ? item : most));
    if (dear.cost === 0) return;

    const scheduled = itinerary.days.flatMap((day) =>
      day.items.map((item) => ({ date: day.date, placeId: item.placeId, start: item.start, kind: item.kind })),
    );
    const otherDate = itinerary.days.map((day) => day.date).find((date) => !hasPlace(itinerary, date, dear.placeId));

    const { json } = await call('POST', '/api/replan', {
      ...basePlan,
      scheduled,
      disruptions: [{ kind: 'move', placeId: dear.placeId, toDate: otherDate }],
    });

    const rejection = json.itinerary.rejected.find((entry: { placeId: string }) => entry.placeId === dear.placeId);
    if (rejection) {
      expect(rejection.reason).toBe('over-budget');
      expect(rejection.detail).toMatch(/of the budget is left/);
      const change = json.changes.find((c: { placeId: string }) => c.placeId === dear.placeId);
      expect(change.reason).toBe(rejection.detail);
    }
  });
});

describe('unknown routes', () => {
  it('404s with JSON rather than HTML', async () => {
    const { status, json } = await call('GET', '/api/nope');
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'Not found' });
  });
});
