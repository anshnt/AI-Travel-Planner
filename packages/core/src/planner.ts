import { DEFAULT_FOOD_SHARE, DEFAULT_MEAL_WINDOWS, isEatery, scheduleMeals } from './meals.js';
import { optimiseItinerary, planObjective, type OptimisationReport } from './optimise.js';
import {
  bestInsertion,
  buildAnchor,
  CITY_CENTRE_ID,
  commitInsertion,
  countStops,
  dayCost,
  newPlanState,
  partyCost,
  returnLeg,
  travelMinutes,
  TRAVEL_PENALTY_PER_HOUR,
  type InsertionCandidate,
  type InsertionSpec,
  type PlanContext,
  type PlannerOptions,
  type PlanState,
  type TimedItem,
  type WorkingDay,
} from './schedule.js';
import { explainScore, formatList, isExcluded, paceProfile, round2, scorePlace } from './scoring.js';
import {
  closingTimeAt,
  dateRange,
  describeHours,
  formatClock,
  formatDuration,
  isClosedAllDay,
  weekdayOf,
} from './time.js';
import { TravelMatrix } from './travel.js';
import { dayWeatherSeverity, describeWetSpell, rainRiskBetween, weatherFit, wetSpells } from './weather.js';
import type {
  DayPlan,
  DayTotals,
  Itinerary,
  MealKind,
  Place,
  PlanRequest,
  Preferences,
  Rejection,
  ScheduledItem,
  TimeWindow,
  TravelLeg,
} from './types.js';

export { countStops, dayCost, partyCost, type PlannerOptions } from './schedule.js';

/** Days may run this much over their notional share of the budget before insertions are refused. */
const DAILY_BUDGET_SLACK = 1.4;

/**
 * Share of one person's daily spend that a single ticket has to reach before it
 * reads as expensive. Anchoring the price scale to the traveller's own budget is
 * what lets the same scoring code judge a EUR 26 ticket and a JPY 1300 one
 * without knowing anything about exchange rates.
 */
const EXPENSIVE_SHARE_OF_DAILY_BUDGET = 0.45;

/** Idle time below this is just slack in the plan; above it, it needs explaining. */
const WAIT_WORTH_MENTIONING_MINUTES = 30;

/** A visit ending this close to closing time had no later option. */
const CLOSING_PRESSURE_MINUTES = 30;

/** Above this much travel, a day is worth flagging as a moving-about day. */
const HEAVY_TRAVEL_MINUTES = 90;

/** A stop the traveller is this indifferent to is not worth the walk to reach it. */
const WORTH_THE_WALK = 0.05;

const MINUTES_IN_DAY = 1440;

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
  meals: ['lunch', 'dinner'],
  mealWindows: DEFAULT_MEAL_WINDOWS,
};

/**
 * What a caller may supply. Everything is optional, and meal windows may be
 * given one at a time -- an API client that only wants a later dinner should not
 * have to restate breakfast and lunch.
 */
export type PreferencesInput = Omit<Partial<Preferences>, 'mealWindows'> & {
  mealWindows?: Partial<Record<MealKind, TimeWindow>>;
};

export function normalizePreferences(partial?: PreferencesInput): Preferences {
  const merged: Preferences = {
    ...DEFAULT_PREFERENCES,
    ...partial,
    mealWindows: { ...DEFAULT_MEAL_WINDOWS, ...partial?.mealWindows },
  };

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
    dayEnd: Math.min(MINUTES_IN_DAY, Math.max(merged.dayEnd, merged.dayStart + 60)),
    maxWalkMinutes: Math.max(5, merged.maxWalkMinutes),
    preferredModes: merged.preferredModes.length > 0 ? merged.preferredModes : ['walk', 'transit'],
    meals: merged.meals ?? [],
  };
}

/**
 * Builds a day-by-day itinerary from a pool of candidate places.
 *
 * Four passes, in this order:
 *
 *  1. must-sees, before the pool competes for the same slots;
 *  2. repeated best-insertion over everything else -- every candidate is tried
 *     in every position of every day, and the one whose appeal best justifies
 *     the detour it adds is committed;
 *  3. meals, once there is a route for a restaurant to sit on;
 *  4. anything a meal displaced, given another chance elsewhere.
 *
 * Pass 2 is slower than filling days front-to-back, but it is what produces days
 * that hang together geographically instead of criss-crossing the city.
 */
/**
 * Everything the passes need, derived once from a request.
 *
 * Split out of `planTrip` so that re-planning an existing itinerary runs through
 * exactly the same setup rather than a parallel copy of it that can drift.
 */
export type PlanSetup = {
  context: PlanContext;
  dates: string[];
  /** Sightseeing candidates the traveller has not ruled out. */
  eligible: Place[];
  eateries: Place[];
  /** Candidates already ruled out, keyed by id, for the caller to add to. */
  rejected: Map<string, Rejection>;
  /** What sightseeing may spend, once food money is held back. */
  activityBudget: number;
  planningMeals: boolean;
};

export function preparePlan(request: PlanRequest, options: PlannerOptions = {}): PlanSetup {
  const preferences = normalizePreferences(request.preferences);
  const dates = dateRange(request.startDate, request.endDate);
  const anchor = buildAnchor(request);

  const pool = dedupeById(request.candidates).filter((place) => place.category !== 'lodging');
  const eateries = pool.filter(isEatery);
  const sights = pool.filter((place) => !isEatery(place));
  const matrix = new TravelMatrix([...pool, anchor], preferences);

  const budgetTotal = Math.max(0, request.budget.total);
  const dailyBudget = request.budget.dailyCap ?? (budgetTotal / dates.length) * DAILY_BUDGET_SLACK;

  // Reserve food money only when meals are actually on the table. Holding back a
  // third of the budget for meals nobody asked for would just shrink the trip.
  const planningMeals = !options.skipMeals && preferences.meals.length > 0 && eateries.length > 0;
  const foodShare = planningMeals ? clamp01(request.budget.foodShare ?? DEFAULT_FOOD_SHARE) : 0;
  const foodReserve = round2(budgetTotal * foodShare);

  const context: PlanContext = {
    request,
    preferences,
    matrix,
    pace: paceProfile(preferences.pace),
    anchor,
    budgetTotal,
    dailyBudget,
    dayCount: dates.length,
    foodReserve,
    scoring: {
      expensivePerPerson: Math.max(
        1,
        (dailyBudget / preferences.travelers) * EXPENSIVE_SHARE_OF_DAILY_BUDGET,
      ),
    },
    weatherByDate: new Map((request.weather ?? []).map((entry) => [entry.date, entry])),
    options,
  };

  const rejected = new Map<string, Rejection>();
  const eligible = partitionEligible(sights, preferences, rejected);

  return {
    context,
    dates,
    eligible,
    eateries,
    rejected,
    activityBudget: round2(budgetTotal - foodReserve),
    planningMeals,
  };
}

/** Empty days spanning the trip, with the traveller's own hours as the bounds. */
export function buildDays(dates: readonly string[], preferences: Preferences): WorkingDay[] {
  return dates.map((date, index) => ({
    date,
    index,
    bounds: { start: preferences.dayStart, end: preferences.dayEnd },
    items: [],
  }));
}

export function planTrip(request: PlanRequest, options: PlannerOptions = {}): Itinerary {
  const setup = preparePlan(request, options);
  const { context, dates, eligible, eateries, rejected, activityBudget, planningMeals } = setup;
  const preferences = context.preferences;

  const days = buildDays(dates, preferences);
  const state = newPlanState(days.length);

  // --- Pass 1: must-sees, before the pool competes for the same slots ---
  const mustSees = eligible
    .filter((place) => preferences.mustSeeIds.includes(place.id))
    .sort(
      (a, b) =>
        scorePlace(b, preferences, context.scoring).total -
          scorePlace(a, preferences, context.scoring).total || a.id.localeCompare(b.id),
    );

  for (const place of mustSees) {
    const candidate = bestInsertion(
      sightSpec(place, context),
      days,
      context,
      activityBudget - state.spent,
      state.spentByDay,
    );
    if (candidate) commitInsertion(candidate, days, state);
    else
      rejected.set(place.id, {
        placeId: place.id,
        name: place.name,
        reason: 'no-feasible-slot',
        detail: 'marked must-see, but no day had an opening that fits it',
      });
  }

  // --- Pass 2: repeated best-insertion over the rest ---
  const remaining = eligible.filter((place) => !state.placed.has(place.id) && !rejected.has(place.id));
  fillGreedily(remaining, days, context, state, () => activityBudget - state.spent);

  // --- Pass 3: meals, now that there is a route for a restaurant to sit on ---
  const mealOutcome = planningMeals
    ? scheduleMeals(eateries, days, context, state)
    : { notesByDay: new Map<number, string[]>(), displaced: [] as TimedItem[] };

  // --- Pass 4: fill again now that the meals are in ---
  // Booking meals reshapes the days, which can open slots that were not there
  // during pass 2 -- both for stops a meal displaced and for stops that never
  // fitted in the first place. Skipping this pass leaves those slots empty, and
  // a later re-plan then appears to "improve" a plan that was simply unfinished.
  const stillOut = [
    ...mealOutcome.displaced.map((entry) => entry.place),
    ...eligible.filter((place) => !state.placed.has(place.id) && !rejected.has(place.id)),
  ];
  if (stillOut.length > 0) {
    fillGreedily(
      dedupeById(stillOut),
      days,
      context,
      state,
      // This pass may spend anything left, food reserve included: the meals it
      // was held back for are already booked by now.
      () => context.budgetTotal - state.spent,
    );
  }

  // --- Pass 5: rearrange what pass 2 committed to too early ---
  // Insertion decides each placement at the moment it makes it, so a stop added
  // early can leave a detour a later addition would have avoided. This pass never
  // adds or removes anything: the traveller gets the same trip, arranged better.
  const optimisation = options.skipOptimisation
    ? undefined
    : optimiseItinerary(days, context);

  for (const place of eligible) {
    if (state.placed.has(place.id) || rejected.has(place.id)) continue;
    rejected.set(place.id, describeRejection(place, dates, context, days));
  }

  return finalize(request, context, days, [...rejected.values()], mealOutcome.notesByDay, optimisation);
}

function biased(spec: InsertionSpec, bias: InsertionBias | undefined): InsertionSpec {
  if (!bias) return spec;
  return {
    ...spec,
    baseScore: spec.baseScore + bias.baseBonus,
    ...(bias.dayPreference ? { dayPreference: bias.dayPreference } : {}),
  };
}

export function sightSpec(place: Place, context: PlanContext): InsertionSpec {
  return {
    place,
    kind: 'activity',
    baseScore: scorePlace(place, context.preferences, context.scoring).total,
    countsAsStop: true,
  };
}

/**
 * Repeated best-insertion: on each round, every remaining candidate is tried in
 * every position of every day, and the single best is committed. Stops when
 * nothing left is worth the travel it would add.
 */
/** Nudges applied to one candidate, used when re-planning to favour continuity. */
export type InsertionBias = {
  baseBonus: number;
  dayPreference?: { dayIndex: number; bonus: number };
};

export function fillGreedily(
  candidates: readonly Place[],
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  remainingBudget: () => number,
  bias?: (place: Place) => InsertionBias,
): void {
  let progress = true;
  while (progress) {
    progress = false;
    let best: InsertionCandidate | null = null;

    for (const place of candidates) {
      if (state.placed.has(place.id)) continue;
      const candidate = bestInsertion(
        biased(sightSpec(place, context), bias?.(place)),
        days,
        context,
        remainingBudget(),
        state.spentByDay,
      );
      if (!candidate) continue;

      // Ties break on id so the same request always yields the same itinerary.
      const better = !best || candidate.gain > best.gain + 1e-9;
      const tiedButEarlierAlphabetically =
        best !== null &&
        Math.abs(candidate.gain - best.gain) <= 1e-9 &&
        candidate.spec.place.id < best.spec.place.id;
      if (better || tiedButEarlierAlphabetically) best = candidate;
    }

    if (best && best.gain > WORTH_THE_WALK) {
      commitInsertion(best, days, state);
      progress = true;
    }
  }
}

function partitionEligible(
  sights: readonly Place[],
  preferences: Preferences,
  rejected: Map<string, Rejection>,
): Place[] {
  const eligible: Place[] = [];
  for (const place of sights) {
    if (!isExcluded(place, preferences)) {
      eligible.push(place);
      continue;
    }
    const avoided = preferences.avoidCategories.includes(place.category);
    rejected.set(place.id, {
      placeId: place.id,
      name: place.name,
      reason: avoided ? 'avoided-category' : 'disliked',
      detail: avoided ? `you asked to skip ${place.category} stops` : 'scores against your stated tastes',
    });
  }
  return eligible;
}

export function describeRejection(
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
  if (score <= WORTH_THE_WALK) {
    return { ...base, reason: 'disliked', detail: 'nothing in your preferences pointed here' };
  }

  // Retry with every money constraint lifted -- the trip total, and the per-day
  // cap. If it fits then, money was the binding constraint, including the fare
  // to get there and back rather than just the ticket price.
  const moneyIsNoObject: PlanContext = { ...context, dailyBudget: Number.POSITIVE_INFINITY };
  const nothingSpentYet = days.map(() => 0);
  if (
    bestInsertion(sightSpec(place, context), days, moneyIsNoObject, Number.POSITIVE_INFINITY, nothingSpentYet)
  ) {
    return { ...base, reason: 'over-budget', detail: 'the budget ran out before this one' };
  }

  return { ...base, reason: 'no-feasible-slot', detail: 'every day was full by the time it came up' };
}

function dedupeById(places: readonly Place[]): Place[] {
  const seen = new Map<string, Place>();
  for (const place of places) if (!seen.has(place.id)) seen.set(place.id, place);
  return [...seen.values()];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function finalize(
  request: PlanRequest,
  context: PlanContext,
  days: readonly WorkingDay[],
  rejected: Rejection[],
  mealNotesByDay: Map<number, string[]>,
  optimisation?: OptimisationReport,
): Itinerary {
  const travelers = context.preferences.travelers;

  const dayPlans: DayPlan[] = days.map((day) => {
    const weather = context.weatherByDate.get(day.date);
    const items: ScheduledItem[] = day.items.map((entry) => ({
      placeId: entry.place.id,
      place: entry.place,
      kind: entry.kind,
      ...(entry.mealKind ? { mealKind: entry.mealKind } : {}),
      start: entry.start,
      end: entry.end,
      cost: partyCost(entry.place, travelers),
      arrival: entry.arrival,
      reasons:
        entry.reasons.length > 0
          ? entry.reasons
          : explainScore(entry.place, context.preferences, context.scoring),
      cautions: weatherFit(entry.place, weather, entry.start, entry.end).cautions,
      locked: entry.locked,
    }));

    const home = returnLeg(day.items, context);
    const totals = totalsFor(items, home ?? undefined);

    return {
      date: day.date,
      weekday: weekdayOf(day.date),
      items,
      ...(weather ? { weather } : {}),
      totals,
      notes: [...dayNotes(day, context), ...(mealNotesByDay.get(day.index) ?? [])],
      ...(home ? { returnToBase: home } : {}),
    };
  });

  const totals = dayPlans.reduce<DayTotals>(
    (acc, day) => ({
      cost: round2(acc.cost + day.totals.cost),
      mealCost: round2(acc.mealCost + day.totals.mealCost),
      travelMinutes: acc.travelMinutes + day.totals.travelMinutes,
      walkMinutes: acc.walkMinutes + day.totals.walkMinutes,
      activeMinutes: acc.activeMinutes + day.totals.activeMinutes,
      distanceMeters: acc.distanceMeters + day.totals.distanceMeters,
    }),
    { cost: 0, mealCost: 0, travelMinutes: 0, walkMinutes: 0, activeMinutes: 0, distanceMeters: 0 },
  );

  const placesVisited = dayPlans.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
    0,
  );
  const mealsBooked = dayPlans.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'meal').length,
    0,
  );

  // The same objective the optimisation pass maximises, weather term included.
  // Reporting a weather-blind figure made an accepted trade -- a few minutes more
  // walking for a dry afternoon -- look like the score had gone down.
  const score = round2(planObjective(days, context));

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
      mealsBooked,
    },
    score,
    rejected,
    ...(optimisation && optimisation.moves.length > 0 ? { optimisation } : {}),
  };
}

export function totalsFor(items: readonly ScheduledItem[], returnToBase?: TravelLeg): DayTotals {
  const legs: TravelLeg[] = items.flatMap((item) => (item.arrival ? [item.arrival] : []));
  if (returnToBase) legs.push(returnToBase);

  return {
    cost: round2(
      items.reduce((sum, item) => sum + item.cost, 0) + legs.reduce((sum, leg) => sum + leg.cost, 0),
    ),
    mealCost: round2(items.filter((item) => item.kind === 'meal').reduce((sum, item) => sum + item.cost, 0)),
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

    // Waiting for a meal window is the plan working as intended, not a gap that
    // needs apologising for.
    if (entry.kind === 'meal') return;

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
    notes.push(
      `${formatDuration(totalTravel)} of getting about today; a transit pass would probably pay for itself.`,
    );
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
      notes.push(
        `Up to ${Math.round(weather.tempMaxC)}°C today; the indoor stops are deliberately in the afternoon.`,
      );
    } else if (weather.tempMinC < 1) {
      notes.push(`Down to ${Math.round(weather.tempMinC)}°C today; the outdoor stops are kept short.`);
    }
  }

  return notes;
}
