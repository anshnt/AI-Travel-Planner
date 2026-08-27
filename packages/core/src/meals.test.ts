import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FOOD_SHARE,
  DEFAULT_MEAL_WINDOWS,
  isEatery,
  MEAL_ORDER,
  meetsDietary,
  scoreMeal,
} from './meals.js';
import { normalizePreferences } from './planner.js';
import type { DietaryTag, MealKind, MealProfile, Place, Preferences } from './types.js';

function eatery(
  id: string,
  meal: Partial<MealProfile> & Pick<MealProfile, 'kinds'>,
  overrides: Partial<Place> = {},
): Place {
  return {
    id,
    name: id,
    category: 'restaurant',
    coord: { lat: 41.39, lon: 2.17 },
    dwellMinutes: 75,
    costPerPerson: meal.costPerPerson ?? 30,
    rating: 4.2,
    tags: ['food'],
    openingHours: { alwaysOpen: true },
    indoor: true,
    ...overrides,
    meal: {
      priceLevel: 2,
      cuisines: [],
      dietary: [],
      costPerPerson: 30,
      ...meal,
    },
  };
}

const preferences = (overrides: Partial<Preferences> = {}) => normalizePreferences(overrides);

describe('isEatery', () => {
  it('recognises restaurants and cafes, and nothing else', () => {
    expect(isEatery(eatery('r', { kinds: ['lunch'] }))).toBe(true);
    expect(isEatery(eatery('c', { kinds: ['breakfast'] }, { category: 'cafe' }))).toBe(true);
    expect(isEatery(eatery('m', { kinds: ['lunch'] }, { category: 'museum' }))).toBe(false);
    expect(isEatery(eatery('k', { kinds: ['lunch'] }, { category: 'market' }))).toBe(false);
  });
});

describe('meetsDietary', () => {
  const vegan = eatery('vegan', { kinds: ['lunch'], dietary: ['vegan', 'vegetarian'] });
  const steakhouse = eatery('steak', { kinds: ['dinner'], dietary: [] });

  it('is satisfied when nothing is required', () => {
    expect(meetsDietary(steakhouse, [])).toBe(true);
  });

  it('requires every tag, not just one', () => {
    expect(meetsDietary(vegan, ['vegan'])).toBe(true);
    expect(meetsDietary(vegan, ['vegan', 'vegetarian'])).toBe(true);
    expect(meetsDietary(vegan, ['vegan', 'halal'])).toBe(false);
  });

  it('rejects a kitchen that caters for none of them', () => {
    expect(meetsDietary(steakhouse, ['vegan'])).toBe(false);
  });

  it('treats a place with no meal profile as unable to cater', () => {
    const noProfile: Place = { ...eatery('x', { kinds: ['lunch'] }) };
    delete (noProfile as { meal?: MealProfile }).meal;
    expect(meetsDietary(noProfile, ['vegan'])).toBe(false);
  });
});

describe('scoreMeal', () => {
  const budget = 35;

  it('refuses a place that does not serve that meal', () => {
    const dinnerOnly = eatery('dinner-only', { kinds: ['dinner'] });
    expect(scoreMeal(dinnerOnly, 'lunch', preferences(), budget)).toBeNull();
    expect(scoreMeal(dinnerOnly, 'dinner', preferences(), budget)).not.toBeNull();
  });

  it('refuses a place with no meal profile at all', () => {
    const museum: Place = { ...eatery('m', { kinds: ['lunch'] }, { category: 'museum' }) };
    delete (museum as { meal?: MealProfile }).meal;
    expect(scoreMeal(museum, 'lunch', preferences(), budget)).toBeNull();
  });

  it('treats dietary requirements as a hard filter, not a scoring term', () => {
    // Perfect on every other axis, and still not an option for a vegan.
    const excellent = eatery('excellent', { kinds: ['lunch'], cuisines: ['catalan'], dietary: [] }, { rating: 5 });
    const modest = eatery('modest', { kinds: ['lunch'], dietary: ['vegan'] }, { rating: 3.2 });
    const vegan = preferences({ dietary: ['vegan'] });

    expect(scoreMeal(excellent, 'lunch', vegan, budget)).toBeNull();
    expect(scoreMeal(modest, 'lunch', vegan, budget)).not.toBeNull();
  });

  it('rewards a cuisine the traveller asked for', () => {
    const wanted = eatery('wanted', { kinds: ['lunch'], cuisines: ['catalan', 'tapas'] });
    const other = eatery('other', { kinds: ['lunch'], cuisines: ['french'] });
    const prefs = preferences({ cuisines: ['catalan'] });
    expect(scoreMeal(wanted, 'lunch', prefs, budget)!.total).toBeGreaterThan(
      scoreMeal(other, 'lunch', prefs, budget)!.total,
    );
  });

  it('matches cuisines case-insensitively', () => {
    const place = eatery('p', { kinds: ['lunch'], cuisines: ['Catalan'] });
    expect(scoreMeal(place, 'lunch', preferences({ cuisines: ['CATALAN'] }), budget)!.reasons.join(' ')).toMatch(
      /serves catalan/,
    );
  });

  it('is neutral on cuisine when the traveller named none', () => {
    const a = eatery('a', { kinds: ['lunch'], cuisines: ['catalan'] });
    const b = eatery('b', { kinds: ['lunch'], cuisines: ['french'] });
    const prefs = preferences();
    expect(scoreMeal(a, 'lunch', prefs, budget)!.total).toBe(scoreMeal(b, 'lunch', prefs, budget)!.total);
  });

  it('does not reward being cheaper than the budget, only penalise being dearer', () => {
    const cheap = eatery('cheap', { kinds: ['lunch'], costPerPerson: 10 });
    const onBudget = eatery('on-budget', { kinds: ['lunch'], costPerPerson: budget });
    const dear = eatery('dear', { kinds: ['lunch'], costPerPerson: budget * 2 });
    const prefs = preferences();

    expect(scoreMeal(cheap, 'lunch', prefs, budget)!.total).toBe(scoreMeal(onBudget, 'lunch', prefs, budget)!.total);
    expect(scoreMeal(dear, 'lunch', prefs, budget)!.total).toBeLessThan(
      scoreMeal(onBudget, 'lunch', prefs, budget)!.total,
    );
  });

  it('rewards food interests the traveller declared', () => {
    const seafood = eatery('seafood', { kinds: ['dinner'] }, { tags: ['food', 'seafood'] });
    const plain = eatery('plain', { kinds: ['dinner'] }, { tags: ['food'] });
    const prefs = preferences({ interests: { seafood: 1 } });
    expect(scoreMeal(seafood, 'dinner', prefs, budget)!.total).toBeGreaterThan(
      scoreMeal(plain, 'dinner', prefs, budget)!.total,
    );
  });

  it('explains its choice in words the traveller can check', () => {
    const place = eatery('place', { kinds: ['lunch'], cuisines: ['catalan'], dietary: ['vegan'], costPerPerson: 12 }, { rating: 4.6 });
    const reasons = scoreMeal(place, 'lunch', preferences({ cuisines: ['catalan'], dietary: ['vegan'] }), budget)!.reasons;
    const text = reasons.join(' | ');
    expect(text).toMatch(/serves catalan/);
    expect(text).toMatch(/comfortably inside your food budget/);
    expect(text).toMatch(/very highly rated/);
    expect(text).toMatch(/caters for vegan/);
  });

  it('copes with a zero food budget rather than dividing by it', () => {
    const place = eatery('place', { kinds: ['lunch'], costPerPerson: 30 });
    const score = scoreMeal(place, 'lunch', preferences(), 0);
    expect(score).not.toBeNull();
    expect(Number.isFinite(score!.total)).toBe(true);
  });
});

describe('meal defaults', () => {
  it('orders the day the way the day runs', () => {
    expect(MEAL_ORDER).toEqual<MealKind[]>(['breakfast', 'lunch', 'dinner']);
  });

  it('puts the windows where people actually eat, and in order', () => {
    expect(DEFAULT_MEAL_WINDOWS.breakfast.start).toBeLessThan(DEFAULT_MEAL_WINDOWS.lunch.start);
    expect(DEFAULT_MEAL_WINDOWS.lunch.start).toBeLessThan(DEFAULT_MEAL_WINDOWS.dinner.start);
    for (const window of Object.values(DEFAULT_MEAL_WINDOWS)) {
      expect(window.end).toBeGreaterThan(window.start);
    }
  });

  it('reserves a plausible share of the budget for food', () => {
    expect(DEFAULT_FOOD_SHARE).toBeGreaterThan(0.2);
    expect(DEFAULT_FOOD_SHARE).toBeLessThan(0.5);
  });

  it('plans lunch and dinner but leaves breakfast to the hotel', () => {
    expect(normalizePreferences().meals).toEqual<MealKind[]>(['lunch', 'dinner']);
  });

  it('lets a caller override one window without losing the others', () => {
    const prefs = normalizePreferences({ mealWindows: { dinner: { start: 21 * 60, end: 23 * 60 } } });
    expect(prefs.mealWindows.dinner).toEqual({ start: 21 * 60, end: 23 * 60 });
    expect(prefs.mealWindows.lunch).toEqual(DEFAULT_MEAL_WINDOWS.lunch);
  });

  it('accepts an explicitly empty meal list', () => {
    expect(normalizePreferences({ meals: [] }).meals).toEqual([]);
  });
});

describe('dietary tags', () => {
  it('covers the requirements that actually change what can be booked', () => {
    const tags: DietaryTag[] = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free'];
    for (const tag of tags) {
      const place = eatery('p', { kinds: ['lunch'], dietary: [tag] });
      expect(meetsDietary(place, [tag])).toBe(true);
    }
  });
});
