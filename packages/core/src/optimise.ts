import {
  dayCost,
  dayWeatherScore,
  retime,
  travelMinutes,
  TRAVEL_PENALTY_PER_HOUR,
  WEATHER_WEIGHT,
  type PlanContext,
  type TimedItem,
  type WorkingDay,
} from './schedule.js';
import { round2 } from './scoring.js';
import { formatClock, formatDuration } from './time.js';
import { wetSpells } from './weather.js';

/**
 * How much better a rearrangement has to be before it is taken.
 *
 * Small enough that a genuine saving is never ignored, large enough that
 * floating-point noise is not mistaken for one -- and that the optimiser cannot
 * churn forever swapping two arrangements of identical value.
 */
const WORTH_DOING = 0.01;

/** Stop after this many rounds even if moves are still being found. */
const DEFAULT_MAX_ROUNDS = 12;

export type OptimiseOptions = {
  maxRounds?: number;
  /** Skip the deferral move, which is the only one that leaves gaps on purpose. */
  skipWeatherDeferral?: boolean;
};

export type OptimisationReport = {
  /** Minutes of travel removed from the trip. Negative would mean a bad trade. */
  travelMinutesSaved: number;
  /** What the optimiser did, in the order it did it. */
  moves: string[];
};

/**
 * The value of an arrangement, on exactly the terms the planner used to build it.
 *
 * Local search that optimises a different objective from the one that produced
 * the plan will happily undo good decisions, so this is deliberately the same
 * sum: appeal, minus the travel it costs, plus how well each stop suits the
 * weather in its slot.
 */
export function planObjective(days: readonly WorkingDay[], context: PlanContext): number {
  let total = 0;
  for (const day of days) {
    total += day.items.reduce((sum, entry) => sum + entry.baseScore, 0);
    total -= (travelMinutes(day.items, context) / 60) * TRAVEL_PENALTY_PER_HOUR;
    if (!context.options.ignoreWeather) total += dayWeatherScore(day.items, day, context) * WEATHER_WEIGHT;
  }
  return total;
}

export function totalTravelMinutes(days: readonly WorkingDay[], context: PlanContext): number {
  return days.reduce((sum, day) => sum + travelMinutes(day.items, context), 0);
}

/** What a move turned out to do, once measured. */
export type MoveEffect = {
  /** Change in trip travel time. Negative means travel was saved. */
  travelMinutesDelta: number;
};

/**
 * A proposed rearrangement.
 *
 * `describe` takes the measured effect rather than assuming one: a move accepted
 * for weather fit can cost a few minutes of travel, and labelling it "saving a
 * detour" would be simply untrue.
 */
type Candidate = {
  describe: (effect: MoveEffect) => string;
  /** Day index to its new item list. Days not listed are unchanged. */
  changes: Map<number, TimedItem[]>;
};

/**
 * Improves an already-built plan by rearranging it.
 *
 * Insertion produces coherent days but commits to each choice at the moment it
 * makes it, so a stop added early can leave a detour that a later addition would
 * have avoided. This pass takes the finished plan and tries a fixed repertoire of
 * moves against it, keeping any that make the objective better and stopping when
 * none do.
 *
 * It never adds or removes a stop. That keeps the pass honest: whatever it does,
 * the traveller still gets the same trip, just arranged better.
 */
export function optimiseItinerary(
  days: WorkingDay[],
  context: PlanContext,
  options: OptimiseOptions = {},
): OptimisationReport {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const travelBefore = totalTravelMinutes(days, context);
  const moves: string[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const current = planObjective(days, context);
    const currentTravel = totalTravelMinutes(days, context);
    let best: { candidate: Candidate; objective: number; effect: MoveEffect } | null = null;

    for (const candidate of proposals(days, context, options)) {
      const trial = withChanges(days, candidate.changes);
      if (!withinBudget(trial, context)) continue;

      const objective = planObjective(trial, context);
      if (objective > current + WORTH_DOING && (!best || objective > best.objective)) {
        best = {
          candidate,
          objective,
          effect: { travelMinutesDelta: totalTravelMinutes(trial, context) - currentTravel },
        };
      }
    }

    if (!best) break;

    for (const [dayIndex, items] of best.candidate.changes) {
      const day = days[dayIndex];
      if (day) day.items = items;
    }
    moves.push(best.candidate.describe(best.effect));
  }

  return {
    travelMinutesSaved: travelBefore - totalTravelMinutes(days, context),
    moves,
  };
}

/**
 * Every rearrangement worth considering, as a lazy sequence.
 *
 * Generated rather than collected so a large plan does not build thousands of
 * trial arrangements before evaluating the first one.
 */
function* proposals(
  days: readonly WorkingDay[],
  context: PlanContext,
  options: OptimiseOptions,
): Generator<Candidate> {
  yield* relocateWithinDay(days, context);
  yield* reverseSegment(days, context);
  yield* moveBetweenDays(days, context);
  if (!options.skipWeatherDeferral && !context.options.ignoreWeather) {
    yield* deferOutOfTheRain(days, context);
  }
}

/** A stop is only free to move if its time is not fixed and it is not locked. */
function isMovable(entry: TimedItem): boolean {
  return entry.fixedStart === undefined && !entry.locked;
}

/**
 * or-opt: take one stop out and put it back somewhere else in the same day.
 *
 * The single most useful move on a day built by insertion, because insertion's
 * mistake is almost always positional: the right stops, in an order that made
 * sense before the last two were added.
 */
function* relocateWithinDay(days: readonly WorkingDay[], context: PlanContext): Generator<Candidate> {
  for (const day of days) {
    const items = day.items;
    for (let from = 0; from < items.length; from += 1) {
      const moving = items[from]!;
      if (!isMovable(moving)) continue;

      const without = items.filter((_, index) => index !== from);
      for (let to = 0; to <= without.length; to += 1) {
        if (to === from) continue;
        const draft = [...without.slice(0, to), moving, ...without.slice(to)];
        const timed = retime(draft, day, context);
        if (!timed) continue;
        yield {
          changes: new Map([[day.index, timed]]),
          describe: (effect) =>
            `moved ${moving.place.name} to ${ordinal(to + 1)} on ${day.date}${becauseOf(effect)}`,
        };
      }
    }
  }
}

/**
 * 2-opt: reverse a run of stops.
 *
 * The move that undoes a crossing. A day that goes north, south, north again
 * usually has a reversible segment in the middle of it.
 */
function* reverseSegment(days: readonly WorkingDay[], context: PlanContext): Generator<Candidate> {
  for (const day of days) {
    const items = day.items;
    for (let start = 0; start < items.length - 1; start += 1) {
      for (let end = start + 1; end < items.length; end += 1) {
        const segment = items.slice(start, end + 1);
        if (!segment.every(isMovable)) continue;

        const draft = [...items.slice(0, start), ...[...segment].reverse(), ...items.slice(end + 1)];
        const timed = retime(draft, day, context);
        if (!timed) continue;
        yield {
          changes: new Map([[day.index, timed]]),
          describe: (effect) => `reversed ${segment.length} stops on ${day.date}${becauseOf(effect)}`,
        };
      }
    }
  }
}

/**
 * Relocates a stop to another day.
 *
 * Insertion decides which day a stop belongs to before it knows what else that
 * day will contain, so a stop can end up on a day it no longer suits.
 */
function* moveBetweenDays(days: readonly WorkingDay[], context: PlanContext): Generator<Candidate> {
  for (const source of days) {
    for (let from = 0; from < source.items.length; from += 1) {
      const moving = source.items[from]!;
      if (!isMovable(moving)) continue;
      // Meals belong to the day they were chosen for, beside that day's route.
      if (moving.kind === 'meal') continue;

      const remaining = source.items.filter((_, index) => index !== from);
      const retimedSource = retime(remaining, source, context);
      if (!retimedSource) continue;

      for (const target of days) {
        if (target.index === source.index) continue;
        if (countsAsStop(target.items) >= context.pace.maxStopsPerDay) continue;

        for (let to = 0; to <= target.items.length; to += 1) {
          const draft = [...target.items.slice(0, to), moving, ...target.items.slice(to)];
          const timed = retime(draft, target, context);
          if (!timed) continue;
          yield {
            changes: new Map([
              [source.index, retimedSource],
              [target.index, timed],
            ]),
            describe: (effect) =>
              `moved ${moving.place.name} from ${source.date} to ${target.date}${becauseOf(effect)}`,
          };
        }
      }
    }
  }
}

/**
 * Holds an outdoor stop back until a shower has passed.
 *
 * The one move that deliberately leaves a gap in the day. Reordering can only
 * put the driest stop in the driest slot; sometimes the right answer is simply to
 * wait forty minutes, which no amount of reordering will discover.
 */
function* deferOutOfTheRain(days: readonly WorkingDay[], context: PlanContext): Generator<Candidate> {
  for (const day of days) {
    const weather = context.weatherByDate.get(day.date);
    if (!weather) continue;

    const spells = wetSpells(weather);
    if (spells.length === 0) continue;

    for (let index = 0; index < day.items.length; index += 1) {
      const entry = day.items[index]!;
      if (!isMovable(entry) || entry.place.indoor) continue;

      for (const spell of spells) {
        // Only worth trying when the stop currently sits inside the shower.
        if (entry.start >= spell.toMinute || entry.end <= spell.fromMinute) continue;

        const draft = day.items.map((item, position) =>
          position === index
            ? { ...item, startWindow: { start: spell.toMinute, end: day.bounds.end } }
            : item,
        );
        const timed = retime(draft, day, context);
        if (!timed) continue;
        yield {
          changes: new Map([[day.index, timed]]),
          describe: () =>
            `held ${entry.place.name} back to ${formatClock(spell.toMinute)} on ${day.date}, after the rain`,
        };
        // Deliberately no `becauseOf`: this move's reason is the rain, whatever it
        // costs in travel.
      }
    }
  }
}

function countsAsStop(items: readonly TimedItem[]): number {
  return items.filter((entry) => entry.countsAsStop).length;
}

/** A shallow copy of the days with some item lists replaced. */
function withChanges(days: readonly WorkingDay[], changes: Map<number, TimedItem[]>): WorkingDay[] {
  return days.map((day) => {
    const replacement = changes.get(day.index);
    return replacement ? { ...day, items: replacement } : day;
  });
}

/**
 * Rearranging changes what the trip costs, because fares depend on the route.
 *
 * A move that saves twenty minutes by switching two walks for two train rides
 * is not an improvement if it puts the trip over budget.
 */
function withinBudget(days: readonly WorkingDay[], context: PlanContext): boolean {
  const total = days.reduce((sum, day) => sum + dayCost(day.items, context), 0);
  return round2(total) <= context.budgetTotal + 1e-9;
}

/**
 * The honest half of a move's description.
 *
 * A move is accepted when the objective improves, and the objective is not only
 * travel: a rearrangement that costs four minutes of walking but puts an outdoor
 * stop in the dry is a good trade. Saying "saving a detour" in that case would be
 * a lie, so the label follows the measurement.
 */
function becauseOf(effect: MoveEffect): string {
  if (effect.travelMinutesDelta < 0) {
    return `, saving ${formatDuration(-effect.travelMinutesDelta)} of travel`;
  }
  if (effect.travelMinutesDelta > 0) {
    return `, at the cost of ${formatDuration(effect.travelMinutesDelta)} more travel but a better fit for the day`;
  }
  return ', for a better fit with the day';
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

function ordinal(position: number): string {
  return ORDINALS[position - 1] ?? `position ${position}`;
}

/** Renders a report for the day notes or a commit message. */
export function describeOptimisation(report: OptimisationReport): string | null {
  if (report.moves.length === 0) return null;
  if (report.travelMinutesSaved <= 0) {
    return `Rearranged ${report.moves.length === 1 ? 'one stop' : `${report.moves.length} stops`} for a better fit.`;
  }
  return `Rearranged the route to save ${formatDuration(report.travelMinutesSaved)} of travel.`;
}
