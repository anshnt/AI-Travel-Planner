import { clamp, formatList, interestScore, round3 } from './scoring.js';
import {
  bestInsertionForDay,
  commitInsertion,
  countStops,
  partyCost,
  removeItem,
  type InsertionCandidate,
  type InsertionSpec,
  type PlanContext,
  type PlanState,
  type TimedItem,
  type WorkingDay,
} from './schedule.js';
import { formatClock, isClosedAllDay, parseClock } from './time.js';
import type { DietaryTag, MealKind, Place, Preferences, TimeWindow } from './types.js';

export const MEAL_ORDER: MealKind[] = ['breakfast', 'lunch', 'dinner'];

/**
 * When people eat, by default.
 *
 * These are windows in which a meal may *start*, not windows it has to finish
 * inside: dinner booked at 21:15 is allowed to run to 23:00, which is what
 * dinners do. Destinations that eat later override them per trip.
 */
export const DEFAULT_MEAL_WINDOWS: Record<MealKind, TimeWindow> = {
  breakfast: { start: parseClock('08:00'), end: parseClock('10:00') },
  lunch: { start: parseClock('12:30'), end: parseClock('14:30') },
  dinner: { start: parseClock('19:30'), end: parseClock('21:30') },
};

/** Share of the trip budget held back for food when the caller does not say. */
export const DEFAULT_FOOD_SHARE = 0.35;

/**
 * A meal has to be worth this much of the activity it displaces before the
 * planner will drop a stop to fit it in.
 *
 * Below 1, because eating is not optional in the way a fifth museum is: a day
 * that skips lunch to squeeze in one more gallery is a worse day, even if the
 * gallery scores higher.
 */
const DISPLACEMENT_THRESHOLD = 0.7;

/**
 * Penalty coefficient for returning to a restaurant already in the plan.
 *
 * Applied as `REPEAT_PENALTY * visits^2`, so the cost escalates: going back
 * somewhere good once is a normal thing to do on holiday and stays available,
 * but a third visit has to beat every alternative by a wide margin. A flat
 * penalty is not enough -- when one restaurant matches the traveller's stated
 * cuisines and the rest do not, a linear cost just books it every night.
 *
 * Repeats are discouraged rather than forbidden because a hard ban runs a
 * four-day trip out of dinners and leaves the traveller with nowhere to eat.
 * Twice in one day is still refused outright.
 */
const REPEAT_PENALTY = 0.18;

/**
 * The most extra travel a meal may add to a day.
 *
 * Twenty minutes buys a walk across a district or a couple of stops on the metro
 * -- enough to reach a genuinely better restaurant, not enough to reorganise the
 * day around one. Without this the meal pass will happily send a day 4 km south
 * for the best tapas match and 4 km back north again, because a strong cuisine
 * score comfortably outbids the soft travel penalty.
 */
const MAX_MEAL_DETOUR_MINUTES = 20;

function repeatPenalty(visits: number): number {
  return REPEAT_PENALTY * visits * visits;
}

export const MEAL_SCORE_WEIGHTS = {
  cuisine: 0.3,
  price: 0.25,
  rating: 0.2,
  interest: 0.25,
} as const;

export type MealScore = {
  total: number;
  reasons: string[];
};

export function isEatery(place: Place): boolean {
  return place.category === 'restaurant' || place.category === 'cafe';
}

/** True when the kitchen can meet every dietary requirement the party has. */
export function meetsDietary(place: Place, required: readonly DietaryTag[]): boolean {
  if (required.length === 0) return true;
  const offered = new Set(place.meal?.dietary ?? []);
  return required.every((tag) => offered.has(tag));
}

/**
 * How good a match a restaurant is for one meal, or `null` when it is not an
 * option at all.
 *
 * Dietary requirements are a hard filter rather than a scoring term on purpose.
 * "Mostly vegan" is not a thing, and a planner that books a steakhouse for a
 * vegan because it scored well on everything else has not understood the
 * request.
 */
export function scoreMeal(
  place: Place,
  mealKind: MealKind,
  preferences: Preferences,
  budgetPerPerson: number,
): MealScore | null {
  const meal = place.meal;
  if (!meal) return null;
  if (!meal.kinds.includes(mealKind)) return null;
  if (!meetsDietary(place, preferences.dietary)) return null;

  const reasons: string[] = [];

  const wanted = preferences.cuisines.map((entry) => entry.toLowerCase());
  const offered = new Set(meal.cuisines.map((entry) => entry.toLowerCase()));
  const matched = wanted.filter((entry) => offered.has(entry));
  const cuisine = wanted.length === 0 ? 0.5 : matched.length / wanted.length;
  if (matched.length > 0) reasons.push(`serves ${formatList(matched)}`);

  // Being under budget is simply fine; the score only falls once a meal starts
  // eating into the rest of the day's food money.
  const perPerson = meal.costPerPerson;
  const price = budgetPerPerson <= 0 ? 0.5 : clamp(1 - Math.max(0, perPerson - budgetPerPerson) / budgetPerPerson, 0, 1);
  if (perPerson <= budgetPerPerson * 0.6) reasons.push('comfortably inside your food budget');

  const rating = clamp(place.rating / 5, 0, 1);
  if (rating >= 0.88) reasons.push(`very highly rated (${place.rating.toFixed(1)}/5)`);

  const interest = clamp(interestScore(place, preferences), -1, 1);
  const interestTags = place.tags.filter((tag) => (preferences.interests[tag.toLowerCase()] ?? 0) > 0.25);
  if (interestTags.length > 0) reasons.push(`matches your interest in ${formatList(interestTags)}`);

  if (preferences.dietary.length > 0) {
    reasons.push(`caters for ${formatList(preferences.dietary)}`);
  }

  const total =
    cuisine * MEAL_SCORE_WEIGHTS.cuisine +
    price * MEAL_SCORE_WEIGHTS.price +
    rating * MEAL_SCORE_WEIGHTS.rating +
    interest * MEAL_SCORE_WEIGHTS.interest;

  return { total: round3(total), reasons };
}

/** Per-person spend a single meal can take before it starts crowding the others. */
export function mealBudgetPerPerson(context: PlanContext, mealsPerDay: number): number {
  const perDay = context.foodReserve / Math.max(1, context.dayCount);
  const travelers = Math.max(1, context.preferences.travelers);
  return perDay / Math.max(1, mealsPerDay) / travelers;
}

export type MealPlanOutcome = {
  /** Day index to the notes explaining what happened to meals that day. */
  notesByDay: Map<number, string[]>;
  /** Activities dropped to make room, for the caller to try re-placing elsewhere. */
  displaced: TimedItem[];
};

/**
 * Books meals into the plan.
 *
 * Runs after sightseeing rather than before it, because a restaurant is only
 * worth choosing relative to where the traveller already is: booking lunch
 * first, with nothing else on the map, just picks the highest-rated place in the
 * city and drags the day across town to reach it.
 *
 * When a day is too full to take a meal, the planner will drop its least
 * valuable unlocked stop to make room -- but only when the meal is worth most of
 * what it displaces, and it says so in the day's notes.
 */
export function scheduleMeals(
  eateries: readonly Place[],
  days: WorkingDay[],
  context: PlanContext,
  state: PlanState,
): MealPlanOutcome {
  const notesByDay = new Map<number, string[]>();
  const displaced: TimedItem[] = [];

  const wanted = MEAL_ORDER.filter((meal) => context.preferences.meals.includes(meal));
  if (wanted.length === 0 || eateries.length === 0) return { notesByDay, displaced };

  const perPersonBudget = mealBudgetPerPerson(context, wanted.length);
  const addNote = (dayIndex: number, note: string): void => {
    const existing = notesByDay.get(dayIndex) ?? [];
    existing.push(note);
    notesByDay.set(dayIndex, existing);
  };

  for (const day of days) {
    // A day with nothing on it has no geography to anchor a restaurant to, and a
    // lone lunch is not an itinerary.
    if (day.items.length === 0) continue;

    for (const mealKind of wanted) {
      const window = context.preferences.mealWindows[mealKind];
      const visitsSoFar = countMealVisits(days);
      const bookedToday = new Set(
        day.items.filter((entry) => entry.kind === 'meal').map((entry) => entry.place.id),
      );

      const compatible = eateries.flatMap((place) => {
        const score = scoreMeal(place, mealKind, context.preferences, perPersonBudget);
        return score ? [{ place, score }] : [];
      });

      if (compatible.length === 0) {
        addNote(
          day.index,
          `No ${mealKind} spot in the list meets your requirements — try relaxing the cuisine or dietary filters.`,
        );
        continue;
      }

      const options = compatible
        .filter(({ place }) => !bookedToday.has(place.id))
        .filter(({ place }) => !isClosedAllDay(place.openingHours, day.date));

      if (options.length === 0) {
        addNote(day.index, `Nothing open for ${mealKind} on this date among your ${mealKind} options.`);
        continue;
      }

      const specs: InsertionSpec[] = options.map(({ place, score }) => ({
        place,
        kind: 'meal',
        mealKind,
        baseScore: score.total - repeatPenalty(visitsSoFar.get(place.id) ?? 0),
        startWindow: window,
        reasons: score.reasons,
        countsAsStop: false,
        maxAddedTravelMinutes: MAX_MEAL_DETOUR_MINUTES,
      }));

      const booked = bookBestOption(specs, day, context, state);
      if (booked) {
        commitInsertion(booked, days, state);
        continue;
      }

      const rescued = makeRoomFor(specs, day, context, state, days);
      if (rescued) {
        displaced.push(rescued.dropped);
        addNote(
          day.index,
          `Dropped ${rescued.dropped.place.name} to fit ${mealKind} at ${rescued.booked.spec.place.name}.`,
        );
        continue;
      }

      // Distinguish "the day is too full" from "the day ends too early" -- the
      // first is the planner's problem, the second is a setting the traveller
      // can change, and telling them so is far more useful than a shrug.
      const shortestVisit = Math.min(...options.map(({ place }) => place.dwellMinutes));
      if (window.start + shortestVisit > day.bounds.end) {
        addNote(
          day.index,
          `${capitalise(mealKind)} starts at ${formatClock(window.start)}, but your day ends at ` +
            `${formatClock(day.bounds.end)}. Push "back by" later, or move the ${mealKind} window earlier.`,
        );
      } else {
        addNote(
          day.index,
          `No room for ${mealKind} between ${formatClock(window.start)} and ${formatClock(window.end)} today.`,
        );
      }
    }
  }

  return { notesByDay, displaced };
}

function bookBestOption(
  specs: readonly InsertionSpec[],
  day: WorkingDay,
  context: PlanContext,
  state: PlanState,
): InsertionCandidate | null {
  const remaining = context.budgetTotal - state.spent;
  let best: InsertionCandidate | null = null;

  for (const spec of specs) {
    // Meals draw on the food reserve, so the per-day activity cap does not
    // apply to them -- otherwise a day of expensive tickets would leave the
    // traveller unable to eat.
    const candidate = bestInsertionForDay(spec, day, context, remaining, 0);
    if (!candidate) continue;
    if (!best || candidate.gain > best.gain + 1e-9) best = candidate;
  }
  return best;
}

/**
 * Tries dropping one stop to make space for a meal.
 *
 * Considers the least valuable unlocked stop first, and keeps the swap only if
 * the meal is worth most of what it cost. If no swap works, the day is left
 * exactly as it was.
 */
function makeRoomFor(
  specs: readonly InsertionSpec[],
  day: WorkingDay,
  context: PlanContext,
  state: PlanState,
  days: WorkingDay[],
): { booked: InsertionCandidate; dropped: TimedItem } | null {
  if (countStops(day.items) <= 1) return null;

  const droppable = day.items
    .filter((entry) => entry.countsAsStop && !entry.locked)
    .sort((a, b) => a.baseScore - b.baseScore || a.place.id.localeCompare(b.place.id));

  for (const candidateToDrop of droppable) {
    const snapshot = [...day.items];
    const snapshotSpent = state.spent;
    const snapshotDaySpent = state.spentByDay[day.index] ?? 0;

    const removal = removeItem(candidateToDrop.place.id, day, context, state);
    if (!removal) continue;

    const booked = bookBestOption(specs, day, context, state);
    if (booked && booked.gain >= candidateToDrop.baseScore * DISPLACEMENT_THRESHOLD) {
      commitInsertion(booked, days, state);
      return { booked, dropped: removal.removed };
    }

    // Not worth it: put the day back exactly as it was.
    day.items = snapshot;
    state.spent = snapshotSpent;
    state.spentByDay[day.index] = snapshotDaySpent;
    state.placed.add(candidateToDrop.place.id);
  }

  return null;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** How many times each restaurant already appears in the plan. */
function countMealVisits(days: readonly WorkingDay[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const day of days) {
    for (const entry of day.items) {
      if (entry.kind !== 'meal') continue;
      counts.set(entry.place.id, (counts.get(entry.place.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Total party spend on meals across a day, for the cost breakdown. */
export function mealSpend(items: readonly TimedItem[], travelers: number): number {
  return items
    .filter((entry) => entry.kind === 'meal')
    .reduce((sum, entry) => sum + partyCost(entry.place, travelers), 0);
}
