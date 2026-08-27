import { scheduleMeals } from './meals.js';
import { optimiseItinerary } from './optimise.js';
import {
  buildDays,
  describeRejection,
  fillGreedily,
  finalize,
  normalizePreferences,
  preparePlan,
  sightSpec,
} from './planner.js';
import {
  bestInsertion,
  bestInsertionForDay,
  commitInsertion,
  newPlanState,
  retime,
  type PlanContext,
  type PlannerOptions,
  type PlanState,
  type TimedItem,
  type WorkingDay,
} from './schedule.js';
import { formatList, round2, scorePlace } from './scoring.js';
import { addDays, formatClock, formatDuration } from './time.js';
import type {
  DailyWeather,
  Itinerary,
  MinuteOfDay,
  OpeningHours,
  Place,
  PlanRequest,
  Rejection,
  ScheduledItem,
} from './types.js';

/**
 * Where the traveller is in the trip.
 *
 * Everything before this moment is history: it happened, so its times are facts
 * rather than preferences, and re-planning may not touch it.
 */
export type Moment = {
  date: string;
  minute: MinuteOfDay;
};

export type Disruption =
  /** The traveller is behind schedule by this many minutes, as of `now`. */
  | { kind: 'running-late'; minutes: number }
  /** A place has turned out to be shut, for one date or for the whole trip. */
  | { kind: 'place-closed'; placeId: string; date?: string }
  /** A fresh forecast has arrived. */
  | { kind: 'forecast-changed'; weather: DailyWeather[] }
  /** The budget has been cut or raised. */
  | { kind: 'budget-changed'; total: number }
  /** Pin a stop so re-planning may neither move nor drop it. */
  | { kind: 'pin'; placeId: string }
  | { kind: 'unpin'; placeId: string }
  /** The traveller has dragged a stop to a different day. */
  | { kind: 'move'; placeId: string; toDate: string }
  /** The traveller no longer wants this stop. */
  | { kind: 'drop'; placeId: string }
  /** The traveller wants this stop fitted in. */
  | { kind: 'add'; placeId: string };

export type ChangeKind = 'kept' | 'retimed' | 'moved' | 'added' | 'dropped';

export type Change = {
  placeId: string;
  name: string;
  kind: ChangeKind;
  from?: { date: string; start: MinuteOfDay };
  to?: { date: string; start: MinuteOfDay };
  /** Why this happened, in words the traveller can act on. */
  reason: string;
};

export type ReplanRequest = {
  /** The plan as it stands. */
  itinerary: Itinerary;
  /** The request that produced it, for the candidate pool and the preferences. */
  base: PlanRequest;
  /** Where the traveller is. Omit to re-plan the whole trip from its start. */
  now?: Moment;
  disruptions: Disruption[];
  /** Stops pinned in earlier rounds, carried forward. */
  pinned?: readonly string[];
};

export type ReplanResult = {
  itinerary: Itinerary;
  changes: Change[];
  /** One or two sentences a traveller would actually read. */
  summary: string[];
  /** Pins after this round, for the caller to carry into the next one. */
  pinned: string[];
};

/**
 * How much a stop already in the plan is favoured when re-planning.
 *
 * Re-planning is a rearrangement, not a fresh start. Someone twenty minutes
 * late wants the rest of their afternoon adjusted, not their whole trip
 * reshuffled into a different but equally good plan -- so a stop that was
 * already scheduled gets a nudge, and a larger nudge towards the day it was on.
 */
const CONTINUITY_BONUS = 0.14;
const SAME_DAY_BONUS = 0.1;

export function replan(request: ReplanRequest, options: PlannerOptions = {}): ReplanResult {
  const { itinerary, base, disruptions } = request;

  // Normalised up front, because `planTrip` accepts a partial preference set and
  // re-planning must not be fussier than planning about the same input.
  const basePreferences = normalizePreferences(base.preferences);

  const before = snapshot(itinerary);
  const closures = collectClosures(disruptions);
  const dropped = new Set(disruptions.flatMap((d) => (d.kind === 'drop' ? [d.placeId] : [])));
  const added = disruptions.flatMap((d) => (d.kind === 'add' ? [d.placeId] : []));
  const moves = new Map(
    disruptions.flatMap((d) => (d.kind === 'move' ? ([[d.placeId, d.toDate]] as [string, string][]) : [])),
  );
  const lateBy = disruptions.reduce((sum, d) => sum + (d.kind === 'running-late' ? d.minutes : 0), 0);

  const pinned = new Set(request.pinned ?? []);
  for (const disruption of disruptions) {
    if (disruption.kind === 'pin') pinned.add(disruption.placeId);
    if (disruption.kind === 'unpin') pinned.delete(disruption.placeId);
  }
  // A stop the traveller has just dragged somewhere is pinned there by that act.
  for (const placeId of moves.keys()) pinned.add(placeId);

  const freshWeather = disruptions.reduce<DailyWeather[] | undefined>(
    (latest, d) => (d.kind === 'forecast-changed' ? d.weather : latest),
    undefined,
  );
  const newBudgetTotal = disruptions.reduce<number | undefined>(
    (latest, d) => (d.kind === 'budget-changed' ? d.total : latest),
    undefined,
  );

  // Rebuild the request with the disruptions folded in, then run the ordinary
  // setup. Re-planning is the same planner over a different starting position,
  // not a second algorithm.
  const revised: PlanRequest = {
    ...base,
    budget: { ...base.budget, ...(newBudgetTotal === undefined ? {} : { total: newBudgetTotal }) },
    ...(freshWeather ? { weather: freshWeather } : {}),
    candidates: base.candidates
      .filter((place) => !dropped.has(place.id))
      .map((place) => applyClosures(place, closures)),
    preferences: {
      ...basePreferences,
      mustSeeIds: [...new Set([...basePreferences.mustSeeIds, ...added, ...pinned])],
    },
  };

  const setup = preparePlan(revised, options);
  const { context, dates, eligible, eateries, rejected, planningMeals } = setup;

  // Two different moments, and conflating them is a real bug rather than a
  // simplification. `historyUpTo` is what actually happened: stops before it are
  // facts. `planFrom` is where planning resumes, which lateness pushes forward --
  // and everything between the two was *missed*, not done. Treating the skipped
  // afternoon as history would silently keep stops the traveller never reached.
  const historyUpTo = request.now;
  const planFrom = effectiveNow(request.now, lateBy, dates, context);

  const days = buildDays(dates, context.preferences);
  const byId = new Map(revised.candidates.map((place) => [place.id, place]));

  const state = newPlanState(days.length);
  const carried = seedFromExisting(itinerary, days, context, state, {
    historyUpTo,
    planFrom,
    pinned,
    dropped,
    closures,
    moves,
    byId,
    // A new forecast is a reason to reconsider the order of a day. Only the days
    // whose weather actually moved are reopened: re-deriving a day whose forecast
    // is unchanged would be churn for its own sake.
    reopenDates: changedForecastDates(base.weather, freshWeather),
  });

  // Anything the seed let go is a candidate again.
  const freed = carried.released;

  // A cut budget has to bite on stops that are already in the plan, not just on
  // ones that have not been chosen yet.
  shedForBudget(days, context, state, freed);

  /**
   * What sightseeing may still spend.
   *
   * Not `activityBudget - spent`: that figure assumes no food money has gone
   * yet, and in a re-plan the meals are usually already booked and counted. Using
   * it leaves sightseeing with a negative allowance and quietly refuses every
   * insertion. Only the food reserve that is still *unspent* is held back.
   */
  const foodCommitted = days.reduce(
    (sum, day) =>
      sum +
      day.items
        .filter((entry) => entry.kind === 'meal')
        .reduce(
          (meals, entry) =>
            meals + Math.max(0, entry.place.costPerPerson) * Math.max(1, context.preferences.travelers),
          0,
        ),
    0,
  );
  const heldBackForFood = Math.max(0, context.foodReserve - foodCommitted);
  const sightseeingBudget = (): number => context.budgetTotal - state.spent - heldBackForFood;

  // Explicit instructions come before the general fill, and are honoured as
  // instructions rather than as suggestions. Adding a moved stop to the must-see
  // list is not enough on its own: the greedy fill would simply put it back
  // wherever it scored best, which is usually where it already was.
  honourMoves(moves, days, context, state, byId, rejected, sightseeingBudget(), freed);
  honourAdditions(added, days, context, state, byId, rejected, sightseeingBudget(), freed);

  const wanted = eligible.filter((place) => !state.placed.has(place.id) && !rejected.has(place.id));

  fillGreedily(
    orderForContinuity(wanted, before, context),
    days,
    context,
    state,
    sightseeingBudget,
    (place) => continuityFor(place, before, dates),
  );

  const mealOutcome = planningMeals
    ? scheduleMeals(eateries, days, context, state)
    : { notesByDay: new Map<number, string[]>(), displaced: [] as TimedItem[] };

  if (mealOutcome.displaced.length > 0) {
    fillGreedily(
      mealOutcome.displaced.map((entry) => entry.place),
      days,
      context,
      state,
      () => context.budgetTotal - state.spent,
    );
  }

  // Rearranging is safe here: the pass never adds or removes a stop, and it
  // cannot touch anything with a fixed time -- which is exactly what history and
  // pins are.
  const optimisation = options.skipOptimisation ? undefined : optimiseItinerary(days, context);

  for (const place of eligible) {
    if (state.placed.has(place.id) || rejected.has(place.id)) continue;
    rejected.set(place.id, describeUnplaced(place, dates, context, days, dropped, closures));
  }

  const next = finalize(
    revised,
    context,
    days,
    [...rejected.values()],
    mealOutcome.notesByDay,
    optimisation,
  );
  const changes = diff(before, snapshot(next), {
    dropped,
    closures,
    lateBy,
    freed,
    // The planner has already worked out why each candidate did not make it; the
    // change list should say the same thing rather than guess again.
    rejections: new Map(next.rejected.map((entry) => [entry.placeId, entry])),
  });

  return {
    itinerary: next,
    changes,
    summary: summarise(changes, disruptions, historyUpTo, planFrom),
    pinned: [...pinned],
  };
}

/**
 * Places each dragged stop on the day the traveller dragged it to, and nowhere
 * else. If it will not fit there, that is reported rather than quietly ignored
 * by putting it back where it was.
 */
function honourMoves(
  moves: Map<string, string>,
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  byId: Map<string, Place>,
  rejected: Map<string, Rejection>,
  activityBudget: number,
  released: Set<string>,
): void {
  for (const [placeId, toDate] of moves) {
    if (state.placed.has(placeId)) continue;
    const place = byId.get(placeId);
    const day = days.find((entry) => entry.date === toDate);
    if (!place) continue;
    if (!day) {
      rejected.set(placeId, {
        placeId,
        name: place.name,
        reason: 'no-feasible-slot',
        detail: `${toDate} is not a day of this trip`,
      });
      continue;
    }

    const placed = insertMakingRoom(place, [day], days, context, state, activityBudget, released);
    if (!placed) rejected.set(placeId, blockedBy(place, context, activityBudget, `on ${toDate}`));
  }
}

/**
 * Why an explicit instruction could not be carried out.
 *
 * "No room" and "no money" are different problems with different remedies, and
 * reporting the first when it was the second sends the traveller looking in the
 * wrong place.
 */
function blockedBy(
  place: Place,
  context: PlanContext,
  budget: number,
  where: string,
): Rejection {
  const cost = Math.max(0, place.costPerPerson) * Math.max(1, context.preferences.travelers);
  if (cost > budget) {
    return {
      placeId: place.id,
      name: place.name,
      reason: 'over-budget',
      detail: `it costs ${cost} and only ${Math.max(0, round2(budget))} of the budget is left`,
    };
  }
  return {
    placeId: place.id,
    name: place.name,
    reason: 'no-feasible-slot',
    detail: `no room for it ${where}, even after clearing space`,
  };
}

/** Gives explicitly requested stops first refusal on the remaining slots. */
function honourAdditions(
  added: readonly string[],
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  byId: Map<string, Place>,
  rejected: Map<string, Rejection>,
  activityBudget: number,
  released: Set<string>,
): void {
  for (const placeId of added) {
    if (state.placed.has(placeId)) continue;
    const place = byId.get(placeId);
    if (!place) continue;

    const placed = insertMakingRoom(place, days, days, context, state, activityBudget, released);
    if (!placed) rejected.set(placeId, blockedBy(place, context, activityBudget, 'on any day'));
  }
}

// ---------------------------------------------------------------------------

type Placement = { date: string; start: MinuteOfDay; name: string; kind: ScheduledItem['kind'] };

function snapshot(itinerary: Itinerary): Map<string, Placement> {
  const map = new Map<string, Placement>();
  for (const day of itinerary.days) {
    for (const item of day.items) {
      map.set(item.placeId, {
        date: day.date,
        start: item.start,
        name: item.place.name,
        kind: item.kind,
      });
    }
  }
  return map;
}

/** Date-specific closures gathered from the disruptions, plus trip-wide ones. */
type Closures = { byDate: Map<string, Set<string>>; always: Set<string> };

function collectClosures(disruptions: readonly Disruption[]): Closures {
  const byDate = new Map<string, Set<string>>();
  const always = new Set<string>();
  for (const disruption of disruptions) {
    if (disruption.kind !== 'place-closed') continue;
    if (disruption.date === undefined) {
      always.add(disruption.placeId);
      continue;
    }
    const existing = byDate.get(disruption.date) ?? new Set<string>();
    existing.add(disruption.placeId);
    byDate.set(disruption.date, existing);
  }
  return { byDate, always };
}

/**
 * Folds a reported closure into the place's own opening hours.
 *
 * Expressing "shut today" as a date exception rather than a special case means
 * every part of the scheduler already understands it -- the feasibility check,
 * the day notes, and the rejection reason all work unchanged.
 */
function applyClosures(place: Place, closures: Closures): Place {
  if (closures.always.has(place.id)) {
    return { ...place, openingHours: { weekly: {} } };
  }
  const dates = [...closures.byDate.entries()]
    .filter(([, ids]) => ids.has(place.id))
    .map(([date]) => date);
  if (dates.length === 0) return place;

  const exceptions: OpeningHours['exceptions'] = { ...place.openingHours.exceptions };
  for (const date of dates) exceptions[date] = [];
  return { ...place, openingHours: { ...place.openingHours, exceptions } };
}

/**
 * The moment re-planning starts from.
 *
 * Running late pushes it forward: that is the whole of what "running late"
 * means to a scheduler.
 */
function effectiveNow(
  now: Moment | undefined,
  lateBy: number,
  dates: readonly string[],
  context: PlanContext,
): Moment | undefined {
  if (!now) return lateBy > 0 ? { date: dates[0]!, minute: context.preferences.dayStart + lateBy } : undefined;
  let date = now.date;
  let minute = now.minute + lateBy;
  // Falling past the end of a day rolls into the next one.
  while (minute >= context.preferences.dayEnd && dates.includes(addDays(date, 1))) {
    date = addDays(date, 1);
    minute = context.preferences.dayStart;
  }
  return { date, minute };
}

/** True when a stop has already happened, or is happening, as of `now`. */
function isHistory(date: string, item: ScheduledItem, now: Moment | undefined): boolean {
  if (!now) return false;
  if (date < now.date) return true;
  if (date > now.date) return false;
  // A visit in progress counts as history: the traveller is standing in it.
  return item.start <= now.minute;
}

type SeedOptions = {
  /** Stops starting at or before this moment happened, and are immovable. */
  historyUpTo: Moment | undefined;
  /** Dates whose arrangement should be re-derived rather than carried over. */
  reopenDates?: Set<string>;
  /** Where re-planning resumes. Nothing new is scheduled before it. */
  planFrom: Moment | undefined;
  pinned: Set<string>;
  dropped: Set<string>;
  closures: Closures;
  moves: Map<string, string>;
  byId: Map<string, Place>;
};

/**
 * Rebuilds the working days from the plan that already exists.
 *
 * This is the heart of re-planning, and the important word is *adjust*. An
 * earlier version released every unpinned stop and re-ran the planner over the
 * empty days, biasing the fill towards the old plan to try to reproduce it. That
 * does not work: greedy insertion is order-sensitive, so a bias meant to
 * stabilise the plan perturbs it instead, and an undisrupted re-plan came back
 * with a stop missing.
 *
 * So the existing arrangement is kept and only *invalidated* stops are released:
 * ones the traveller dropped, ones reported closed, ones dragged elsewhere. The
 * day is then re-timed, and if the re-timed day no longer fits -- because the
 * traveller has lost two hours -- its least valuable stops are shed one at a
 * time until it does. Everything shed goes back into the pool for another day.
 *
 * An undisrupted re-plan is therefore a no-op by construction, rather than by
 * luck.
 */
function seedFromExisting(
  itinerary: Itinerary,
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  options: SeedOptions,
): { released: Set<string> } {
  const released = new Set<string>();
  const dayByDate = new Map(days.map((day) => [day.date, day]));

  // Raise the floor first: re-timing has to know where the day now starts.
  if (options.planFrom) {
    const resumeDay = dayByDate.get(options.planFrom.date);
    if (resumeDay) {
      resumeDay.bounds = { ...resumeDay.bounds, start: Math.max(resumeDay.bounds.start, options.planFrom.minute) };
    }
    for (const other of days) {
      if (other.date < options.planFrom.date) other.bounds = { ...other.bounds, start: other.bounds.end };
    }
  }

  for (const oldDay of itinerary.days) {
    const day = dayByDate.get(oldDay.date);
    if (!day) continue;

    let keep: TimedItem[] = [];
    for (const item of oldDay.items) {
      const place = options.byId.get(item.placeId);
      if (!place) continue;

      // Invalidated: gone from this day whatever else happens.
      if (options.dropped.has(item.placeId)) continue;
      if (options.closures.always.has(item.placeId)) continue;
      if (options.closures.byDate.get(oldDay.date)?.has(item.placeId)) {
        released.add(item.placeId);
        continue;
      }
      if (options.moves.has(item.placeId) && options.moves.get(item.placeId) !== oldDay.date) {
        released.add(item.placeId);
        continue;
      }

      const history = isHistory(oldDay.date, item, options.historyUpTo);
      const pinnedHere = options.pinned.has(item.placeId);

      // A reopened day gives up its unfixed stops so the order can be worked out
      // again from the new conditions.
      if (options.reopenDates?.has(oldDay.date) && !history && !pinnedHere) {
        if (item.kind !== 'meal') released.add(item.placeId);
        continue;
      }

      keep.push({
        place,
        kind: item.kind,
        ...(item.mealKind ? { mealKind: item.mealKind } : {}),
        start: item.start,
        end: item.end,
        arrival: item.arrival ?? {
          fromPlaceId: context.anchor.id,
          toPlaceId: place.id,
          mode: 'walk',
          minutes: 0,
          meters: 0,
          cost: 0,
        },
        locked: history || pinnedHere,
        reasons: item.reasons,
        // History is a fact and a pin is a promise; everything else is free to
        // shift as the day is re-timed around them.
        ...(history || pinnedHere ? { fixedStart: item.start } : {}),
        ...(history ? { immovable: true } : {}),
        ...(item.mealKind ? { startWindow: context.preferences.mealWindows[item.mealKind] } : {}),
        baseScore: scorePlace(place, context.preferences, context.scoring).total,
        countsAsStop: item.kind !== 'meal',
      });
    }

    day.items = shedUntilFeasible(keep, day, context, released);

    for (const entry of day.items) {
      if (entry.kind !== 'meal') state.placed.add(entry.place.id);
    }
  }

  // Money already committed still counts against the budget.
  for (const day of days) {
    const spent = day.items.reduce(
      (sum, entry) =>
        sum + Math.max(0, entry.place.costPerPerson) * Math.max(1, context.preferences.travelers) + entry.arrival.cost,
      0,
    );
    state.spentByDay[day.index] = Math.round(spent * 100) / 100;
    state.spent = Math.round((state.spent + spent) * 100) / 100;
  }

  return { released };
}

/**
 * Re-times a day, shedding stops until it fits.
 *
 * Sightseeing goes before meals, and the least wanted goes first. A day squeezed
 * by two lost hours should give up its fifth museum before it gives up lunch.
 */
function shedUntilFeasible(
  items: readonly TimedItem[],
  day: WorkingDay,
  context: PlanContext,
  released: Set<string>,
): TimedItem[] {
  let keep = [...items];

  for (;;) {
    const timed = retime(keep, day, context);
    if (timed) return timed;

    const shed = leastValuableSheddable(keep);
    if (!shed) return [];

    keep = keep.filter((entry) => entry !== shed);
    // Meals are re-booked by the meal pass, so only sights go back in the pool.
    if (shed.kind !== 'meal') released.add(shed.place.id);
  }
}

/**
 * Dates whose forecast has materially changed.
 *
 * Compared on the figures the scheduler actually reads -- the hourly rain, the
 * temperature range, the wind -- so a provider that re-sends an identical
 * forecast does not reshuffle the trip.
 */
function changedForecastDates(
  before: readonly DailyWeather[] | undefined,
  after: readonly DailyWeather[] | undefined,
): Set<string> {
  if (!after) return new Set();
  const previous = new Map((before ?? []).map((entry) => [entry.date, entry]));
  const changed = new Set<string>();

  for (const entry of after) {
    const was = previous.get(entry.date);
    if (!was || !sameWeather(was, entry)) changed.add(entry.date);
  }
  return changed;
}

function sameWeather(a: DailyWeather, b: DailyWeather): boolean {
  if (
    a.precipitationChance !== b.precipitationChance ||
    a.tempMinC !== b.tempMinC ||
    a.tempMaxC !== b.tempMaxC ||
    a.windKph !== b.windKph
  ) {
    return false;
  }
  const aHours = a.hourly ?? [];
  const bHours = b.hourly ?? [];
  if (aHours.length !== bHours.length) return false;
  return aHours.every((hour, index) => {
    const other = bHours[index];
    return (
      other !== undefined &&
      hour.hour === other.hour &&
      hour.precipitationChance === other.precipitationChance &&
      hour.tempC === other.tempC
    );
  });
}

/**
 * Sheds stops until the plan fits a budget that has been cut.
 *
 * Free stops are never shed: dropping them would cost the traveller a sight and
 * save nothing. Committed money -- stops that have already happened -- is not
 * recoverable and is simply accepted.
 */
function shedForBudget(
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  released: Set<string>,
): void {
  const partyCostOf = (entry: TimedItem): number =>
    Math.max(0, entry.place.costPerPerson) * Math.max(1, context.preferences.travelers);

  for (;;) {
    if (state.spent <= context.budgetTotal) return;

    let worst: { day: WorkingDay; entry: TimedItem } | null = null;
    for (const day of days) {
      for (const entry of day.items) {
        if (entry.fixedStart !== undefined) continue;
        if (partyCostOf(entry) <= 0) continue;
        if (!worst || entry.baseScore < worst.entry.baseScore) worst = { day, entry };
      }
    }
    if (!worst) return;

    const { day, entry } = worst;
    const remaining = day.items.filter((item) => item !== entry);
    day.items = retime(remaining, day, context) ?? remaining;
    if (entry.kind !== 'meal') {
      released.add(entry.place.id);
      state.placed.delete(entry.place.id);
    }

    const refund = partyCostOf(entry) + entry.arrival.cost;
    state.spentByDay[day.index] = round2((state.spentByDay[day.index] ?? 0) - refund);
    state.spent = round2(state.spent - refund);
  }
}

/**
 * Places a stop the traveller explicitly asked for, making room if it has to.
 *
 * "Fit this in" and "put this on Thursday" are instructions. If the day is
 * already full, the right answer is to give up its least wanted stop -- not to
 * shrug and report that there was no space.
 *
 * What it places is locked. Without that, the later passes of the same re-plan
 * can undo the instruction that caused them: meal scheduling is allowed to
 * displace the least valuable stop of a day, and a stop that has just been moved
 * there is often exactly that -- so the traveller asks for a stop on Wednesday,
 * is told it moved to Wednesday, and finds a restaurant in its place.
 */
function insertMakingRoom(
  place: Place,
  candidateDays: WorkingDay[],
  allDays: WorkingDay[],
  context: PlanContext,
  state: PlanState,
  budget: number,
  released: Set<string>,
): boolean {
  const spec = { ...sightSpec(place, context), locked: true };

  const direct =
    candidateDays.length === 1
      ? bestInsertionForDay(spec, candidateDays[0]!, context, budget, state.spentByDay[candidateDays[0]!.index] ?? 0)
      : bestInsertion(spec, candidateDays, context, budget, state.spentByDay);
  if (direct) {
    commitInsertion(direct, allDays, state);
    return true;
  }

  for (const day of candidateDays) {
    const sheddable = day.items
      .filter((entry) => entry.fixedStart === undefined && entry.kind !== 'meal')
      .sort((a, b) => a.baseScore - b.baseScore || a.place.id.localeCompare(b.place.id));

    for (const victim of sheddable) {
      const snapshotItems = [...day.items];
      const snapshotSpent = state.spent;
      const snapshotDaySpent = state.spentByDay[day.index] ?? 0;

      const withoutVictim = day.items.filter((entry) => entry !== victim);
      const retimed = retime(withoutVictim, day, context);
      if (!retimed) continue;
      day.items = retimed;
      state.placed.delete(victim.place.id);

      const candidate = bestInsertionForDay(spec, day, context, budget, state.spentByDay[day.index] ?? 0);
      if (candidate) {
        commitInsertion(candidate, allDays, state);
        released.add(victim.place.id);
        return true;
      }

      day.items = snapshotItems;
      state.spent = snapshotSpent;
      state.spentByDay[day.index] = snapshotDaySpent;
      state.placed.add(victim.place.id);
    }
  }

  return false;
}

function leastValuableSheddable(items: readonly TimedItem[]): TimedItem | null {
  const flexible = items.filter((entry) => entry.fixedStart === undefined);
  const sights = flexible.filter((entry) => entry.kind !== 'meal');
  const pool = sights.length > 0 ? sights : flexible;
  if (pool.length === 0) return null;
  return pool.reduce((worst, entry) =>
    entry.baseScore < worst.baseScore || (entry.baseScore === worst.baseScore && entry.place.id < worst.place.id)
      ? entry
      : worst,
  );
}

/** Continuity bias for one candidate: was it in the plan, and where? */
function continuityFor(
  place: Place,
  before: Map<string, Placement>,
  dates: readonly string[],
): { baseBonus: number; dayPreference?: { dayIndex: number; bonus: number } } {
  const previous = before.get(place.id);
  if (!previous) return { baseBonus: 0 };
  const dayIndex = dates.indexOf(previous.date);
  return {
    baseBonus: CONTINUITY_BONUS,
    ...(dayIndex >= 0 ? { dayPreference: { dayIndex, bonus: SAME_DAY_BONUS } } : {}),
  };
}

/**
 * Puts previously scheduled stops first.
 *
 * `fillGreedily` already picks the globally best insertion each round, so order
 * only breaks exact ties -- but breaking them towards the existing plan is free
 * stability.
 */
function orderForContinuity(
  candidates: readonly Place[],
  before: Map<string, Placement>,
  context: PlanContext,
): Place[] {
  return [...candidates].sort((a, b) => {
    const wasA = before.has(a.id) ? 1 : 0;
    const wasB = before.has(b.id) ? 1 : 0;
    if (wasA !== wasB) return wasB - wasA;
    return (
      scorePlace(b, context.preferences, context.scoring).total -
        scorePlace(a, context.preferences, context.scoring).total || a.id.localeCompare(b.id)
    );
  });
}

function describeUnplaced(
  place: Place,
  dates: readonly string[],
  context: PlanContext,
  days: readonly WorkingDay[],
  dropped: Set<string>,
  closures: Closures,
): Rejection {
  if (dropped.has(place.id)) {
    return { placeId: place.id, name: place.name, reason: 'disliked', detail: 'you took this off the list' };
  }
  if (closures.always.has(place.id)) {
    return { placeId: place.id, name: place.name, reason: 'closed-on-all-days', detail: 'reported as closed' };
  }
  return describeRejection(place, dates, context, days);
}

// ---------------------------------------------------------------------------

type DiffContext = {
  dropped: Set<string>;
  closures: Closures;
  lateBy: number;
  freed: Set<string>;
  rejections: Map<string, Rejection>;
};

/**
 * What changed, and why.
 *
 * A new itinerary on its own is not an answer to "what happened?" -- the point
 * of re-planning is that the traveller can see which of their stops survived,
 * which slipped, and what fell off.
 */
function diff(
  before: Map<string, Placement>,
  after: Map<string, Placement>,
  context: DiffContext,
): Change[] {
  const changes: Change[] = [];

  for (const [placeId, was] of before) {
    const now = after.get(placeId);

    if (!now) {
      changes.push({
        placeId,
        name: was.name,
        kind: 'dropped',
        from: { date: was.date, start: was.start },
        reason: dropReason(placeId, context),
      });
      continue;
    }

    if (now.date !== was.date) {
      changes.push({
        placeId,
        name: was.name,
        kind: 'moved',
        from: { date: was.date, start: was.start },
        to: { date: now.date, start: now.start },
        reason: `moved to ${now.date} at ${formatClock(now.start)}, where it fits`,
      });
      continue;
    }

    if (now.start !== was.start) {
      const shift = now.start - was.start;
      changes.push({
        placeId,
        name: was.name,
        kind: 'retimed',
        from: { date: was.date, start: was.start },
        to: { date: now.date, start: now.start },
        reason:
          shift > 0
            ? `${formatDuration(shift)} later, at ${formatClock(now.start)}`
            : `${formatDuration(-shift)} earlier, at ${formatClock(now.start)}`,
      });
      continue;
    }

    changes.push({
      placeId,
      name: was.name,
      kind: 'kept',
      from: { date: was.date, start: was.start },
      to: { date: now.date, start: now.start },
      reason: 'unchanged',
    });
  }

  for (const [placeId, now] of after) {
    if (before.has(placeId)) continue;
    changes.push({
      placeId,
      name: now.name,
      kind: 'added',
      to: { date: now.date, start: now.start },
      reason: `added on ${now.date} at ${formatClock(now.start)} — there was room`,
    });
  }

  // Most-disruptive first: what fell off matters more than what stayed put.
  const order: ChangeKind[] = ['dropped', 'moved', 'added', 'retimed', 'kept'];
  return changes.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

function dropReason(placeId: string, context: DiffContext): string {
  if (context.dropped.has(placeId)) return 'you took this off the list';
  if (context.closures.always.has(placeId)) return 'reported as closed';
  for (const [date, ids] of context.closures.byDate) {
    if (ids.has(placeId)) return `closed on ${date}, and no other day had room`;
  }

  // The planner's own verdict beats a guess from the disruption list.
  const rejection = context.rejections.get(placeId);
  if (rejection?.reason === 'over-budget' && rejection.detail) return rejection.detail;

  if (context.lateBy > 0) return `no longer fits after losing ${formatDuration(context.lateBy)}`;
  return rejection?.detail ?? 'no longer fits the rest of the plan';
}

function summarise(
  changes: readonly Change[],
  disruptions: readonly Disruption[],
  historyUpTo: Moment | undefined,
  planFrom: Moment | undefined,
): string[] {
  const counts = {
    dropped: changes.filter((change) => change.kind === 'dropped').length,
    moved: changes.filter((change) => change.kind === 'moved').length,
    added: changes.filter((change) => change.kind === 'added').length,
    retimed: changes.filter((change) => change.kind === 'retimed').length,
  };

  const lines: string[] = [];
  const causes = disruptions.map(describeDisruption).filter(Boolean);
  if (causes.length > 0) lines.push(`${formatList(causes)}.`);

  const effects: string[] = [];
  if (counts.dropped > 0) effects.push(`${counts.dropped} dropped`);
  if (counts.moved > 0) effects.push(`${counts.moved} moved to another day`);
  if (counts.retimed > 0) effects.push(`${counts.retimed} retimed`);
  if (counts.added > 0) effects.push(`${counts.added} added`);

  const untouched = historyUpTo
    ? ` Everything up to ${formatClock(historyUpTo.minute)} on ${historyUpTo.date} was left alone.`
    : '';
  lines.push(effects.length === 0 ? `Nothing needed to change.${untouched}` : `${formatList(effects)}.${untouched}`);

  if (planFrom && historyUpTo && (planFrom.date !== historyUpTo.date || planFrom.minute !== historyUpTo.minute)) {
    lines.push(`Picking the plan back up at ${formatClock(planFrom.minute)} on ${planFrom.date}.`);
  }

  return lines;
}

function describeDisruption(disruption: Disruption): string {
  switch (disruption.kind) {
    case 'running-late':
      return `running ${formatDuration(disruption.minutes)} late`;
    case 'place-closed':
      return disruption.date ? `a stop closed on ${disruption.date}` : 'a stop reported closed';
    case 'forecast-changed':
      return 'a new forecast';
    case 'budget-changed':
      return `budget changed to ${disruption.total}`;
    case 'pin':
      return 'a stop pinned';
    case 'unpin':
      return 'a stop unpinned';
    case 'move':
      return `a stop moved to ${disruption.toDate}`;
    case 'drop':
      return 'a stop removed';
    case 'add':
      return 'a stop requested';
    default:
      return '';
  }
}
