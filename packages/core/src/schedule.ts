import { round2, type PaceProfile, type ScoreOptions } from './scoring.js';
import { earliestFeasibleStart, isClosedAllDay } from './time.js';
import { TravelMatrix } from './travel.js';
import { weatherFit } from './weather.js';
import type {
  DailyWeather,
  ItemKind,
  MealKind,
  MinuteOfDay,
  Place,
  PlanRequest,
  Preferences,
  TimeWindow,
  TravelLeg,
} from './types.js';

/**
 * Turning an hour of travel into "score" so the two can be traded off.
 *
 * At 0.22 per hour, the planner will happily add a 20-minute hop for a place the
 * traveller loves, but not for one they are lukewarm about -- which is the
 * behaviour that keeps days geographically coherent without becoming rigid.
 */
export const TRAVEL_PENALTY_PER_HOUR = 0.22;

/**
 * How much the forecast is allowed to move the plan.
 *
 * At 0.4 a soaking-wet slot can outweigh a moderate preference match -- enough
 * to reliably swap a park for a gallery in the wet hours -- but never enough to
 * override a strong one. Someone who came to Barcelona for Gaudi still gets
 * Gaudi in the rain; they just get the indoor half of it first.
 */
export const WEATHER_WEIGHT = 0.4;

/** Synthetic id for the day's anchor when the trip has no lodging. */
export const CITY_CENTRE_ID = '__origin__';

export type PlannerOptions = {
  /** Skip the geographic-coherence penalty; used by tests that assert pure ranking. */
  ignoreTravelPenalty?: boolean;
  /** Plan weather-blind even when a forecast is supplied. */
  ignoreWeather?: boolean;
  /** Skip meal scheduling entirely. */
  skipMeals?: boolean;
};

/** Cost of visiting a place for the whole party. */
export function partyCost(place: Place, travelers: number): number {
  return round2(Math.max(0, place.costPerPerson) * Math.max(1, travelers));
}

export type TimedItem = {
  place: Place;
  kind: ItemKind;
  mealKind?: MealKind;
  start: MinuteOfDay;
  end: MinuteOfDay;
  arrival: TravelLeg;
  locked: boolean;
  reasons: string[];
  /**
   * Constrains when the visit may *begin*, not when it must end -- a dinner
   * booked in the 19:30-21:30 window is allowed to run past 21:30, which is
   * what dinners do.
   */
  startWindow?: TimeWindow;
  /** Value of having this in the plan, before travel and weather adjustments. */
  baseScore: number;
  /** Whether this consumes the day's sightseeing-stop allowance. Meals do not. */
  countsAsStop: boolean;
};

export type WorkingDay = {
  date: string;
  index: number;
  bounds: TimeWindow;
  items: TimedItem[];
};

export type PlanContext = {
  request: PlanRequest;
  preferences: Preferences;
  matrix: TravelMatrix;
  pace: PaceProfile;
  /** Where every day begins and ends. */
  anchor: Place;
  budgetTotal: number;
  dailyBudget: number;
  /** Number of days in the trip. */
  dayCount: number;
  /** Portion of the trip budget held back for food. */
  foodReserve: number;
  /** Trip-specific price scale handed to every scoring call. */
  scoring: ScoreOptions;
  /** Forecast by ISO date; days with no entry are planned weather-blind. */
  weatherByDate: Map<string, DailyWeather>;
  options: PlannerOptions;
};

/** Running totals shared by every scheduling pass. */
export type PlanState = {
  spentByDay: number[];
  spent: number;
  placed: Set<string>;
};

export function newPlanState(dayCount: number): PlanState {
  return { spentByDay: new Array<number>(dayCount).fill(0), spent: 0, placed: new Set() };
}

/**
 * The day's anchor: the lodging when one is given, otherwise a zero-cost
 * stand-in at the centre of the destination. Having an anchor at all is what
 * lets the planner reason about the first and last legs of a day instead of
 * pretending the traveller materialises at their first stop.
 */
export function buildAnchor(request: PlanRequest): Place {
  if (request.lodging) return request.lodging;
  return {
    id: CITY_CENTRE_ID,
    name: `${request.destination.name} centre`,
    category: 'lodging',
    coord: request.destination.center,
    dwellMinutes: 0,
    costPerPerson: 0,
    rating: 0,
    tags: [],
    openingHours: { alwaysOpen: true },
    indoor: false,
  };
}

/**
 * Re-times a whole day from its anchor.
 *
 * Every insertion and every reorder runs through here, which is deliberate: the
 * schedule is always recomputed from first principles rather than patched, so a
 * change early in the day correctly ripples into every later arrival time.
 * Returns `null` when the sequence cannot be made to fit.
 */
export function retime(
  sequence: readonly TimedItem[],
  day: WorkingDay,
  context: PlanContext,
): TimedItem[] | null {
  const { matrix, pace, anchor } = context;
  const timed: TimedItem[] = [];
  let cursor = day.bounds.start;
  let previousId = anchor.id;

  for (const entry of sequence) {
    const leg = matrix.leg(previousId, entry.place.id);
    const arriveAt = Math.max(cursor + leg.minutes, entry.startWindow?.start ?? 0);
    const start = earliestFeasibleStart(
      entry.place.openingHours,
      day.date,
      arriveAt,
      entry.place.dwellMinutes,
      day.bounds.end,
    );
    if (start === null) return null;
    if (entry.startWindow && start > entry.startWindow.end) return null;

    const end = start + entry.place.dwellMinutes;
    timed.push({ ...entry, start, end, arrival: leg });
    cursor = end + pace.bufferMinutes;
    previousId = entry.place.id;
  }

  // Meals are time at a table, not time on your feet, so they do not count
  // against the pace ceiling -- a relaxed three-stop day plus lunch and dinner
  // is still a relaxed day.
  const activeMinutes = timed
    .filter((entry) => entry.countsAsStop)
    .reduce((sum, entry) => sum + (entry.end - entry.start), 0);
  if (activeMinutes > pace.maxActiveMinutes) return null;

  return timed;
}

/**
 * The journey home from the last stop of the day.
 *
 * Counted during planning, not just in the final totals: getting back costs both
 * time and money, and a planner that ignores it will quietly overspend its
 * budget and happily end the day on the far side of the city.
 */
export function returnLeg(items: readonly TimedItem[], context: PlanContext): TravelLeg | null {
  const last = items[items.length - 1];
  return last ? context.matrix.leg(last.place.id, context.anchor.id) : null;
}

export function dayCost(items: readonly TimedItem[], context: PlanContext): number {
  const travelers = context.preferences.travelers;
  const visits = items.reduce((sum, entry) => sum + partyCost(entry.place, travelers), 0);
  const travel = items.reduce((sum, entry) => sum + entry.arrival.cost, 0);
  return round2(visits + travel + (returnLeg(items, context)?.cost ?? 0));
}

export function travelMinutes(items: readonly TimedItem[], context: PlanContext): number {
  return (
    items.reduce((sum, entry) => sum + entry.arrival.minutes, 0) + (returnLeg(items, context)?.minutes ?? 0)
  );
}

/**
 * How well a whole day's sequence suits that day's forecast.
 *
 * Scored over the sequence rather than per place, because weather fit depends on
 * *when* a stop happens: moving the gallery earlier changes the park's slot too.
 * Insertions are judged on the change in this figure, exactly as they are on the
 * change in travel time.
 */
export function dayWeatherScore(
  items: readonly TimedItem[],
  day: WorkingDay,
  context: PlanContext,
): number {
  const weather = context.weatherByDate.get(day.date);
  if (!weather) return 0;
  return items.reduce((sum, entry) => sum + weatherFit(entry.place, weather, entry.start, entry.end).fit, 0);
}

export function countStops(items: readonly TimedItem[]): number {
  return items.filter((entry) => entry.countsAsStop).length;
}

/** Everything needed to try fitting one candidate into the plan. */
export type InsertionSpec = {
  place: Place;
  kind: ItemKind;
  mealKind?: MealKind;
  baseScore: number;
  startWindow?: TimeWindow;
  reasons?: string[];
  countsAsStop: boolean;
};

export type InsertionCandidate = {
  spec: InsertionSpec;
  dayIndex: number;
  position: number;
  timed: TimedItem[];
  /** Base score, minus the travel it costs, plus what it does for weather fit. */
  gain: number;
  addedTravelMinutes: number;
  addedCost: number;
};

function draftItem(spec: InsertionSpec): TimedItem {
  return {
    place: spec.place,
    kind: spec.kind,
    ...(spec.mealKind ? { mealKind: spec.mealKind } : {}),
    start: 0,
    end: 0,
    arrival: { fromPlaceId: '', toPlaceId: spec.place.id, mode: 'walk', minutes: 0, meters: 0, cost: 0 },
    locked: false,
    reasons: spec.reasons ?? [],
    ...(spec.startWindow ? { startWindow: spec.startWindow } : {}),
    baseScore: spec.baseScore,
    countsAsStop: spec.countsAsStop,
  };
}

/**
 * Best way to fit one candidate into one day, or `null` if it does not fit
 * anywhere in that day. Every position is tried because the right answer is
 * often "third stop, not last" -- a place that closes at 14:00 has to come
 * early, and only a full positional search finds that.
 */
export function bestInsertionForDay(
  spec: InsertionSpec,
  day: WorkingDay,
  context: PlanContext,
  remainingBudget: number,
  spentToday: number,
): InsertionCandidate | null {
  if (spec.countsAsStop && countStops(day.items) >= context.pace.maxStopsPerDay) return null;
  if (isClosedAllDay(spec.place.openingHours, day.date)) return null;

  const visitCost = partyCost(spec.place, context.preferences.travelers);
  const baseTravel = travelMinutes(day.items, context);
  const baseCost = dayCost(day.items, context);
  const baseWeather = dayWeatherScore(day.items, day, context);

  let best: InsertionCandidate | null = null;

  for (let position = 0; position <= day.items.length; position += 1) {
    const draft: TimedItem[] = [
      ...day.items.slice(0, position),
      draftItem(spec),
      ...day.items.slice(position),
    ];

    const timed = retime(draft, day, context);
    if (!timed) continue;

    const addedTravelMinutes = travelMinutes(timed, context) - baseTravel;
    const addedCost = round2(dayCost(timed, context) - baseCost);

    if (addedCost > remainingBudget) continue;
    if (spentToday + addedCost > context.dailyBudget && visitCost > 0) continue;

    const penalty = context.options.ignoreTravelPenalty
      ? 0
      : (addedTravelMinutes / 60) * TRAVEL_PENALTY_PER_HOUR;
    const weatherDelta = context.options.ignoreWeather
      ? 0
      : (dayWeatherScore(timed, day, context) - baseWeather) * WEATHER_WEIGHT;
    const gain = spec.baseScore - penalty + weatherDelta;

    // Positions are tried in order, so an exact tie resolves to the later slot.
    // That keeps places in the order the planner chose them -- the most wanted
    // stop stays first -- instead of newcomers jumping the queue for free.
    const clearlyBetter = !best || gain > best.gain + 1e-9;
    const tiedWithAnEarlierSlot = best !== null && Math.abs(gain - best.gain) <= 1e-9;
    if (clearlyBetter || tiedWithAnEarlierSlot) {
      best = { spec, dayIndex: day.index, position, timed, gain, addedTravelMinutes, addedCost };
    }
  }

  return best;
}

export function bestInsertion(
  spec: InsertionSpec,
  days: readonly WorkingDay[],
  context: PlanContext,
  remainingBudget: number,
  spentByDay: readonly number[],
): InsertionCandidate | null {
  let best: InsertionCandidate | null = null;
  for (const day of days) {
    const candidate = bestInsertionForDay(spec, day, context, remainingBudget, spentByDay[day.index] ?? 0);
    if (!candidate) continue;
    if (!best || candidate.gain > best.gain + 1e-9) best = candidate;
  }
  return best;
}

/** Applies an insertion to the working plan and the running totals. */
export function commitInsertion(
  candidate: InsertionCandidate,
  days: WorkingDay[],
  state: PlanState,
): void {
  const day = days[candidate.dayIndex];
  if (!day) throw new Error(`commitInsertion: no day at index ${candidate.dayIndex}`);
  day.items = candidate.timed;
  state.spentByDay[candidate.dayIndex] = round2((state.spentByDay[candidate.dayIndex] ?? 0) + candidate.addedCost);
  state.spent = round2(state.spent + candidate.addedCost);
  // `placed` is what stops a sight being scheduled twice. Meals are deliberately
  // left out of it: repeat visits are handled by the meal planner, which
  // discourages them with a score penalty rather than forbidding them.
  if (candidate.spec.kind !== 'meal') state.placed.add(candidate.spec.place.id);
}

/**
 * Removes one item from a day and re-times what is left.
 *
 * Used when something more important needs its slot -- dropping the least
 * valuable stop to fit lunch in. Returns the freed money, or `null` if what
 * remains cannot be re-timed (which should not happen, since a shorter sequence
 * is always at least as feasible, but is checked rather than assumed).
 */
export function removeItem(
  placeId: string,
  day: WorkingDay,
  context: PlanContext,
  state: PlanState,
): { removed: TimedItem; refund: number } | null {
  const index = day.items.findIndex((entry) => entry.place.id === placeId);
  if (index === -1) return null;
  const removed = day.items[index]!;
  if (removed.locked) return null;

  const before = dayCost(day.items, context);
  const remaining = day.items.filter((_, position) => position !== index);
  const timed = retime(remaining, day, context);
  if (!timed) return null;

  day.items = timed;
  const refund = round2(before - dayCost(timed, context));
  state.spentByDay[day.index] = round2((state.spentByDay[day.index] ?? 0) - refund);
  state.spent = round2(state.spent - refund);
  state.placed.delete(placeId);
  return { removed, refund };
}
