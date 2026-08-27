import {
  round2,
  formatList,
  isExcluded,
  explainScore,
  paceProfile,
  scorePlace,
  type PaceProfile,
  type ScoreOptions,
} from './scoring.js';
import {
  closingTimeAt,
  dateRange,
  describeHours,
  earliestFeasibleStart,
  formatClock,
  formatDuration,
  isClosedAllDay,
  weekdayOf,
} from './time.js';
import { TravelMatrix } from './travel.js';
import {
  dayWeatherSeverity,
  describeWetSpell,
  rainRiskBetween,
  weatherFit,
  wetSpells,
} from './weather.js';
import type {
  DailyWeather,
  DayPlan,
  DayTotals,
  Itinerary,
  MinuteOfDay,
  Place,
  PlanRequest,
  Preferences,
  Rejection,
  RejectionReason,
  ScheduledItem,
  TimeWindow,
  TravelLeg,
} from './types.js';

/**
 * Turning an hour of walking into "score" so the two can be traded off.
 *
 * At 0.22 per hour, the planner will happily add a 20-minute hop for a place the
 * traveller loves, but not for one they are lukewarm about -- which is the
 * behaviour that keeps days geographically coherent without becoming rigid.
 */
const TRAVEL_PENALTY_PER_HOUR = 0.22;

/**
 * How much the forecast is allowed to move the plan.
 *
 * At 0.4 a soaking-wet slot can outweigh a moderate preference match -- enough
 * to reliably swap a park for a gallery in the wet hours -- but never enough to
 * override a strong one. Someone who came to Barcelona for Gaudi still gets
 * Gaudi in the rain; they just get the indoor half of it first.
 */
const WEATHER_WEIGHT = 0.4;

/** Days may run this much over their notional share of the budget before insertions are refused. */
const DAILY_BUDGET_SLACK = 1.4;

/**
 * Share of one person's daily spend that a single ticket has to reach before it
 * reads as expensive. Anchoring the price scale to the traveller's own budget is
 * what lets the same scoring code judge a EUR 26 ticket and a JPY 1300 one
 * without knowing anything about exchange rates.
 */
const EXPENSIVE_SHARE_OF_DAILY_BUDGET = 0.45;

/** Synthetic id for the day's anchor when the trip has no lodging. */
const CITY_CENTRE_ID = '__origin__';

/** Idle time below this is just slack in the plan; above it, it needs explaining. */
const WAIT_WORTH_MENTIONING_MINUTES = 30;

/** A visit ending this close to closing time had no later option. */
const CLOSING_PRESSURE_MINUTES = 30;

/** Above this much travel, a day is worth flagging as a moving-about day. */
const HEAVY_TRAVEL_MINUTES = 90;

const MINUTES_IN_DAY = 1440;

export type PlannerOptions = {
  /** Skip the geographic-coherence penalty; used by tests that assert pure ranking. */
  ignoreTravelPenalty?: boolean;
  /** Plan weather-blind even when a forecast is supplied. */
  ignoreWeather?: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  interests: {},
  pace: 'balanced',
  dayStart: 9 * 60,
  dayEnd: 20 * 60,
  maxWalkMinutes: 22,
  preferredModes: ['walk', 'transit'],
  avoidCategories: [],
  dietary: [],
  cuisines: [],
  mustSeeIds: [],
  travelers: 2,
};

export function normalizePreferences(partial?: Partial<Preferences>): Preferences {
  const merged: Preferences = { ...DEFAULT_PREFERENCES, ...partial };
  const interests: Record<string, number> = {};
  for (const [tag, weight] of Object.entries(merged.interests ?? {})) {
    if (typeof weight === 'number' && Number.isFinite(weight)) {
      interests[tag.toLowerCase()] = Math.min(1, Math.max(-1, weight));
    }
  }
  return {
    ...merged,
    interests,
    travelers: Math.max(1, Math.round(merged.travelers)),
    dayStart: Math.max(0, Math.min(merged.dayStart, merged.dayEnd - 60)),
    dayEnd: Math.min(24 * 60, Math.max(merged.dayEnd, merged.dayStart + 60)),
    maxWalkMinutes: Math.max(5, merged.maxWalkMinutes),
    preferredModes: merged.preferredModes.length > 0 ? merged.preferredModes : ['walk', 'transit'],
  };
}

/** Cost of visiting a place for the whole party. */
export function partyCost(place: Place, travelers: number): number {
  return round2(Math.max(0, place.costPerPerson) * Math.max(1, travelers));
}

type TimedItem = {
  place: Place;
  start: MinuteOfDay;
  end: MinuteOfDay;
  arrival: TravelLeg;
  locked: boolean;
  reasons: string[];
};

type WorkingDay = {
  date: string;
  index: number;
  bounds: TimeWindow;
  items: TimedItem[];
};

type PlanContext = {
  request: PlanRequest;
  preferences: Preferences;
  matrix: TravelMatrix;
  pace: PaceProfile;
  /** Where every day begins and ends. */
  anchor: Place;
  budgetTotal: number;
  dailyBudget: number;
  /** Trip-specific price scale handed to every scoring call. */
  scoring: ScoreOptions;
  /** Forecast by ISO date; days with no entry are planned weather-blind. */
  weatherByDate: Map<string, DailyWeather>;
  options: PlannerOptions;
};

/**
 * The day's anchor: the lodging when one is given, otherwise a zero-cost
 * stand-in at the centre of the destination. Having an anchor at all is what
 * lets the planner reason about the first and last legs of a day instead of
 * pretending the traveller materialises at their first stop.
 */
function buildAnchor(request: PlanRequest): Place {
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
function retime(sequence: readonly TimedItem[], day: WorkingDay, context: PlanContext): TimedItem[] | null {
  const { matrix, pace, anchor } = context;
  const timed: TimedItem[] = [];
  let cursor = day.bounds.start;
  let previousId = anchor.id;

  for (const entry of sequence) {
    const leg = matrix.leg(previousId, entry.place.id);
    const arriveAt = cursor + leg.minutes;
    const start = earliestFeasibleStart(
      entry.place.openingHours,
      day.date,
      arriveAt,
      entry.place.dwellMinutes,
      day.bounds.end,
    );
    if (start === null) return null;

    const end = start + entry.place.dwellMinutes;
    timed.push({ ...entry, start, end, arrival: leg });
    cursor = end + pace.bufferMinutes;
    previousId = entry.place.id;
  }

  const activeMinutes = timed.reduce((sum, entry) => sum + (entry.end - entry.start), 0);
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
function returnLeg(items: readonly TimedItem[], context: PlanContext): TravelLeg | null {
  const last = items[items.length - 1];
  return last ? context.matrix.leg(last.place.id, context.anchor.id) : null;
}

function dayCost(items: readonly TimedItem[], context: PlanContext): number {
  const travelers = context.preferences.travelers;
  const visits = items.reduce((sum, entry) => sum + partyCost(entry.place, travelers), 0);
  const travel = items.reduce((sum, entry) => sum + entry.arrival.cost, 0);
  return round2(visits + travel + (returnLeg(items, context)?.cost ?? 0));
}

/**
 * How well a whole day's sequence suits that day's forecast.
 *
 * Scored over the sequence rather than per place, because weather fit depends on
 * *when* a stop happens: moving the gallery earlier changes the park's slot too.
 * Insertions are judged on the change in this figure, exactly as they are on the
 * change in travel time.
 */
function dayWeatherScore(items: readonly TimedItem[], day: WorkingDay, context: PlanContext): number {
  const weather = context.weatherByDate.get(day.date);
  if (!weather) return 0;
  return items.reduce((sum, entry) => sum + weatherFit(entry.place, weather, entry.start, entry.end).fit, 0);
}

function travelMinutes(items: readonly TimedItem[], context: PlanContext): number {
  return (
    items.reduce((sum, entry) => sum + entry.arrival.minutes, 0) +
    (returnLeg(items, context)?.minutes ?? 0)
  );
}

type InsertionCandidate = {
  place: Place;
  dayIndex: number;
  position: number;
  timed: TimedItem[];
  /** Score gained minus the travel it costs. Higher is better. */
  gain: number;
  addedTravelMinutes: number;
  addedCost: number;
};

/**
 * Best way to fit one place into one day, or `null` if it does not fit anywhere
 * in that day. Every position is tried because the right answer is often "third
 * stop, not last" -- a place that closes at 14:00 has to come early, and only a
 * full positional search finds that.
 */
function bestInsertionForDay(
  place: Place,
  day: WorkingDay,
  context: PlanContext,
  remainingBudget: number,
  spentToday: number,
): InsertionCandidate | null {
  if (day.items.length >= context.pace.maxStopsPerDay) return null;
  if (isClosedAllDay(place.openingHours, day.date)) return null;

  const visitCost = partyCost(place, context.preferences.travelers);
  const baseTravel = travelMinutes(day.items, context);
  const baseCost = dayCost(day.items, context);
  const baseWeather = dayWeatherScore(day.items, day, context);
  const score = scorePlace(place, context.preferences, context.scoring).total;

  let best: InsertionCandidate | null = null;

  for (let position = 0; position <= day.items.length; position += 1) {
    const draft: TimedItem[] = [
      ...day.items.slice(0, position),
      {
        place,
        start: 0,
        end: 0,
        arrival: { fromPlaceId: '', toPlaceId: place.id, mode: 'walk', minutes: 0, meters: 0, cost: 0 },
        locked: false,
        reasons: [],
      },
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
    const gain = score - penalty + weatherDelta;

    // Positions are tried in order, so an exact tie resolves to the later slot.
    // That keeps places in the order the planner chose them -- the most wanted
    // stop stays first -- instead of newcomers jumping the queue for free.
    const clearlyBetter = !best || gain > best.gain + 1e-9;
    const tiedWithAnEarlierSlot = best !== null && Math.abs(gain - best.gain) <= 1e-9;
    if (clearlyBetter || tiedWithAnEarlierSlot) {
      best = { place, dayIndex: day.index, position, timed, gain, addedTravelMinutes, addedCost };
    }
  }

  return best;
}

function bestInsertion(
  place: Place,
  days: readonly WorkingDay[],
  context: PlanContext,
  remainingBudget: number,
  spentByDay: readonly number[],
): InsertionCandidate | null {
  let best: InsertionCandidate | null = null;
  for (const day of days) {
    const candidate = bestInsertionForDay(place, day, context, remainingBudget, spentByDay[day.index] ?? 0);
    if (!candidate) continue;
    if (!best || candidate.gain > best.gain + 1e-9) best = candidate;
  }
  return best;
}

/**
 * Builds a day-by-day itinerary from a pool of candidate places.
 *
 * The strategy is repeated best-insertion: on every pass the planner looks at
 * every unplaced candidate in every position of every day, and commits the one
 * whose appeal best justifies the detour it adds. That is slower than filling
 * days front-to-back, but it is what produces days that hang together
 * geographically instead of criss-crossing the city.
 */
export function planTrip(request: PlanRequest, options: PlannerOptions = {}): Itinerary {
  const preferences = normalizePreferences(request.preferences);
  const dates = dateRange(request.startDate, request.endDate);
  const anchor = buildAnchor(request);

  const pool = dedupeById(request.candidates).filter((place) => place.category !== 'lodging');
  const matrix = new TravelMatrix([...pool, anchor], preferences);

  const budgetTotal = Math.max(0, request.budget.total);
  const dailyBudget = request.budget.dailyCap ?? (budgetTotal / dates.length) * DAILY_BUDGET_SLACK;

  const context: PlanContext = {
    request,
    preferences,
    matrix,
    pace: paceProfile(preferences.pace),
    anchor,
    budgetTotal,
    dailyBudget,
    scoring: {
      expensivePerPerson: Math.max(
        1,
        (dailyBudget / preferences.travelers) * EXPENSIVE_SHARE_OF_DAILY_BUDGET,
      ),
    },
    weatherByDate: new Map((request.weather ?? []).map((entry) => [entry.date, entry])),
    options,
  };

  const days: WorkingDay[] = dates.map((date, index) => ({
    date,
    index,
    bounds: { start: preferences.dayStart, end: preferences.dayEnd },
    items: [],
  }));

  const rejected = new Map<string, Rejection>();
  const eligible: Place[] = [];
  for (const place of pool) {
    if (isExcluded(place, preferences)) {
      rejected.set(place.id, {
        placeId: place.id,
        name: place.name,
        reason: preferences.avoidCategories.includes(place.category) ? 'avoided-category' : 'disliked',
        detail: preferences.avoidCategories.includes(place.category)
          ? `you asked to skip ${place.category} stops`
          : 'scores against your stated tastes',
      });
      continue;
    }
    // Restaurants are scheduled by the meal planner, not as sightseeing stops.
    if (place.category === 'restaurant' || place.category === 'cafe') continue;
    eligible.push(place);
  }

  const spentByDay = new Array<number>(days.length).fill(0);
  let spent = 0;
  const placed = new Set<string>();

  const commit = (candidate: InsertionCandidate): void => {
    const day = days[candidate.dayIndex]!;
    day.items = candidate.timed;
    spentByDay[candidate.dayIndex] = round2((spentByDay[candidate.dayIndex] ?? 0) + candidate.addedCost);
    spent = round2(spent + candidate.addedCost);
    placed.add(candidate.place.id);
  };

  // Pass 1: must-sees get in first, before the pool competes for the same slots.
  const mustSees = eligible
    .filter((place) => preferences.mustSeeIds.includes(place.id))
    .sort(
      (a, b) =>
        scorePlace(b, preferences, context.scoring).total - scorePlace(a, preferences, context.scoring).total ||
        a.id.localeCompare(b.id),
    );

  for (const place of mustSees) {
    const candidate = bestInsertion(place, days, context, context.budgetTotal - spent, spentByDay);
    if (candidate) commit(candidate);
    else
      rejected.set(place.id, {
        placeId: place.id,
        name: place.name,
        reason: 'no-feasible-slot',
        detail: 'marked must-see, but no day had an opening that fits it',
      });
  }

  // Pass 2: repeated best-insertion across everything that is left.
  const remaining = eligible.filter((place) => !placed.has(place.id) && !rejected.has(place.id));
  let progress = true;
  while (progress) {
    progress = false;
    let best: InsertionCandidate | null = null;

    for (const place of remaining) {
      if (placed.has(place.id)) continue;
      const candidate = bestInsertion(place, days, context, context.budgetTotal - spent, spentByDay);
      if (!candidate) continue;
      // Ties break on id so the same request always yields the same itinerary.
      if (!best || candidate.gain > best.gain + 1e-9 || (Math.abs(candidate.gain - best.gain) <= 1e-9 && candidate.place.id < best.place.id)) {
        best = candidate;
      }
    }

    // A stop the traveller is indifferent to is not worth the walk to reach it.
    if (best && best.gain > 0.05) {
      commit(best);
      progress = true;
    }
  }

  for (const place of remaining) {
    if (placed.has(place.id) || rejected.has(place.id)) continue;
    rejected.set(place.id, describeRejection(place, dates, context, days));
  }

  return finalize(request, context, days, [...rejected.values()]);
}

function describeRejection(
  place: Place,
  dates: readonly string[],
  context: PlanContext,
  days: readonly WorkingDay[],
): Rejection {
  const base = { placeId: place.id, name: place.name };
  if (dates.every((date) => isClosedAllDay(place.openingHours, date))) {
    return { ...base, reason: 'closed-on-all-days', detail: 'shut for every day of your trip' };
  }

  const score = scorePlace(place, context.preferences, context.scoring).total;
  if (score <= 0.05) {
    return { ...base, reason: 'disliked', detail: 'nothing in your preferences pointed here' };
  }

  // Retry with every money constraint lifted -- the trip total, and the per-day
  // cap. If it fits then, money was the binding constraint, including the fare
  // to get there and back rather than just the ticket price.
  const moneyIsNoObject: PlanContext = { ...context, dailyBudget: Number.POSITIVE_INFINITY };
  const nothingSpentYet = days.map(() => 0);
  if (bestInsertion(place, days, moneyIsNoObject, Number.POSITIVE_INFINITY, nothingSpentYet)) {
    return { ...base, reason: 'over-budget', detail: 'the budget ran out before this one' };
  }

  return { ...base, reason: 'no-feasible-slot', detail: 'every day was full by the time it came up' };
}

function dedupeById(places: readonly Place[]): Place[] {
  const seen = new Map<string, Place>();
  for (const place of places) if (!seen.has(place.id)) seen.set(place.id, place);
  return [...seen.values()];
}

function finalize(
  request: PlanRequest,
  context: PlanContext,
  days: readonly WorkingDay[],
  rejected: Rejection[],
): Itinerary {
  const weatherByDate = new Map((request.weather ?? []).map((entry) => [entry.date, entry]));
  const travelers = context.preferences.travelers;

  const dayPlans: DayPlan[] = days.map((day) => {
    const weather = weatherByDate.get(day.date);
    const items: ScheduledItem[] = day.items.map((entry) => ({
      placeId: entry.place.id,
      place: entry.place,
      kind: 'activity',
      start: entry.start,
      end: entry.end,
      cost: partyCost(entry.place, travelers),
      arrival: entry.arrival,
      reasons:
        entry.reasons.length > 0 ? entry.reasons : explainScore(entry.place, context.preferences, context.scoring),
      cautions: weatherFit(entry.place, weather, entry.start, entry.end).cautions,
      locked: entry.locked,
    }));

    const last = day.items[day.items.length - 1];
    const returnToBase = last ? context.matrix.leg(last.place.id, context.anchor.id) : undefined;

    const totals = totalsFor(items, returnToBase);
    return {
      date: day.date,
      weekday: weekdayOf(day.date),
      items,
      weather: weatherByDate.get(day.date),
      totals,
      notes: dayNotes(day, context),
      returnToBase,
    };
  });

  const totals = dayPlans.reduce<DayTotals>(
    (acc, day) => ({
      cost: round2(acc.cost + day.totals.cost),
      travelMinutes: acc.travelMinutes + day.totals.travelMinutes,
      walkMinutes: acc.walkMinutes + day.totals.walkMinutes,
      activeMinutes: acc.activeMinutes + day.totals.activeMinutes,
      distanceMeters: acc.distanceMeters + day.totals.distanceMeters,
    }),
    { cost: 0, travelMinutes: 0, walkMinutes: 0, activeMinutes: 0, distanceMeters: 0 },
  );

  const placesVisited = dayPlans.reduce((sum, day) => sum + day.items.length, 0);
  const score = round2(
    dayPlans
      .flatMap((day) => day.items)
      .reduce((sum, item) => sum + scorePlace(item.place, context.preferences, context.scoring).total, 0) -
      (totals.travelMinutes / 60) * TRAVEL_PENALTY_PER_HOUR,
  );

  return {
    destination: request.destination,
    startDate: request.startDate,
    endDate: request.endDate,
    currency: request.budget.currency,
    days: dayPlans,
    totals: {
      ...totals,
      budgetRemaining: round2(context.budgetTotal - totals.cost),
      placesVisited,
    },
    score,
    rejected,
  };
}

export function totalsFor(items: readonly ScheduledItem[], returnToBase?: TravelLeg): DayTotals {
  const legs: TravelLeg[] = items.flatMap((item) => (item.arrival ? [item.arrival] : []));
  if (returnToBase) legs.push(returnToBase);

  return {
    cost: round2(
      items.reduce((sum, item) => sum + item.cost, 0) + legs.reduce((sum, leg) => sum + leg.cost, 0),
    ),
    travelMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
    walkMinutes: legs.filter((leg) => leg.mode === 'walk').reduce((sum, leg) => sum + leg.minutes, 0),
    activeMinutes: items.reduce((sum, item) => sum + (item.end - item.start), 0),
    distanceMeters: legs.reduce((sum, leg) => sum + leg.meters, 0),
  };
}

/**
 * Day-level advisories.
 *
 * These exist so the plan can justify itself. "Why does Tuesday start with a
 * park?" is a fair question, and "because the gallery does not open until 11:00"
 * is a much better answer than silence. Every note here is tied to a decision
 * the scheduler actually made -- listing a place's hours when those hours
 * constrained nothing is noise, not explanation.
 */
function dayNotes(day: WorkingDay, context: PlanContext): string[] {
  const notes: string[] = [];
  if (day.items.length === 0) {
    notes.push('Nothing scheduled: no candidate fit this day inside your hours and budget.');
    return notes;
  }

  if (context.anchor.id !== CITY_CENTRE_ID) {
    notes.push(`Starts and ends at ${context.anchor.name}.`);
  }

  // Idle time the traveller did not ask for is always worth explaining: it means
  // the next place was not open yet.
  day.items.forEach((entry, index) => {
    const previous = day.items[index - 1];
    const readyAt =
      (previous ? previous.end + context.pace.bufferMinutes : day.bounds.start) + entry.arrival.minutes;
    const wait = entry.start - readyAt;
    if (wait < WAIT_WORTH_MENTIONING_MINUTES) return;

    notes.push(
      index === 0
        ? `${entry.place.name} opens at ${formatClock(entry.start)} (${describeHours(entry.place.openingHours, day.date)}), so the day starts a little later.`
        : `${formatDuration(wait)} to spare before ${entry.place.name} opens at ${formatClock(entry.start)} — its hours today are ${describeHours(entry.place.openingHours, day.date)}.`,
    );
  });

  // A visit that only just fits before closing explains why it is where it is.
  for (const entry of day.items) {
    const closes = closingTimeAt(entry.place.openingHours, day.date, entry.start);
    if (closes === null || closes >= MINUTES_IN_DAY) continue;
    if (closes - entry.end <= CLOSING_PRESSURE_MINUTES) {
      notes.push(`${entry.place.name} shuts at ${formatClock(closes)}, so it could not go any later.`);
    }
  }

  notes.push(...weatherNotes(day, context));

  const totalTravel = travelMinutes(day.items, context);
  if (totalTravel > HEAVY_TRAVEL_MINUTES) {
    notes.push(`${formatDuration(totalTravel)} of getting about today; a transit pass would probably pay for itself.`);
  }

  return notes;
}

/**
 * What the forecast did to the day.
 *
 * Says whether the plan managed to dodge the weather or merely acknowledges it,
 * because "rain 13:00 to 16:00, and you are in a museum for it" and "rain 13:00
 * to 16:00, and you are in a park for it" are very different pieces of news.
 */
function weatherNotes(day: WorkingDay, context: PlanContext): string[] {
  const weather = context.weatherByDate.get(day.date);
  if (!weather) return [];

  const notes: string[] = [];
  const spells = wetSpells(weather);

  if (spells.length > 0) {
    const worst = spells.reduce((best, spell) => (spell.peakRisk > best.peakRisk ? spell : best));
    const exposed = day.items.filter(
      (entry) => !entry.place.indoor && rainRiskBetween(weather, entry.start, entry.end) >= 0.4,
    );
    const sheltered = day.items.filter(
      (entry) => entry.place.indoor && rainRiskBetween(weather, entry.start, entry.end) >= 0.4,
    );

    const window = `Rain likely ${describeWetSpell(worst)} (${Math.round(worst.peakRisk * 100)}%)`;
    if (exposed.length === 0 && sheltered.length > 0) {
      notes.push(`${window}: ${formatList(sheltered.map((entry) => entry.place.name))} sits under cover for it.`);
    } else if (exposed.length > 0) {
      notes.push(`${window}, and ${formatList(exposed.map((entry) => entry.place.name))} is outdoors. Take a coat.`);
    } else {
      notes.push(`${window}, but nothing is scheduled through it.`);
    }
  }

  if (dayWeatherSeverity(weather) === 'poor' && spells.length === 0) {
    if (weather.tempMaxC > 34) {
      notes.push(`Up to ${Math.round(weather.tempMaxC)}°C today; the indoor stops are deliberately in the afternoon.`);
    } else if (weather.tempMinC < 1) {
      notes.push(`Down to ${Math.round(weather.tempMinC)}°C today; the outdoor stops are kept short.`);
    }
  }

  return notes;
}
