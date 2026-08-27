import type { Pace, Place, Preferences } from './types.js';

/**
 * How many stops and how much on-your-feet time a day can hold.
 *
 * These are the numbers that decide whether a plan feels like a holiday or a
 * forced march, so they are stated once, here, rather than scattered through the
 * scheduler.
 */
export type PaceProfile = {
  /** Upper bound on activities (meals excluded) in a single day. */
  maxStopsPerDay: number;
  /** Upper bound on minutes spent at places, travel excluded. */
  maxActiveMinutes: number;
  /** Breathing room left after each stop, so the plan is not back-to-back. */
  bufferMinutes: number;
};

export const PACE_PROFILES: Record<Pace, PaceProfile> = {
  relaxed: { maxStopsPerDay: 3, maxActiveMinutes: 300, bufferMinutes: 25 },
  balanced: { maxStopsPerDay: 5, maxActiveMinutes: 420, bufferMinutes: 15 },
  packed: { maxStopsPerDay: 7, maxActiveMinutes: 540, bufferMinutes: 8 },
};

export function paceProfile(pace: Pace): PaceProfile {
  return PACE_PROFILES[pace] ?? PACE_PROFILES.balanced;
}

export type ScoreBreakdown = {
  /** How well the place matches declared interests, -1 (avoid) to 1 (love). */
  interest: number;
  /** Crowd rating normalised to 0-1. */
  rating: number;
  /** Experience per unit of money, 0-1. Free places score highest. */
  value: number;
  /** Weighted sum of the terms above. Higher is better. */
  total: number;
};

/**
 * Relative pull of each signal.
 *
 * Interest dominates on purpose. A four-star museum the traveller has no
 * appetite for should lose to a three-star one they actually want to see --
 * a planner that optimises for ratings just rebuilds the same generic
 * top-ten list for everybody.
 */
export const SCORE_WEIGHTS = {
  interest: 0.58,
  rating: 0.18,
  value: 0.24,
} as const;

/**
 * Fallback for "what counts as an expensive ticket, per person, per hour of
 * visit". Only used when the caller does not supply a trip-specific figure --
 * the planner derives one from the actual budget, which is what keeps value
 * scoring sane across currencies as different in scale as the euro and the yen.
 */
export const DEFAULT_EXPENSIVE_PER_PERSON = 45;

export type ScoreOptions = {
  /** Per-person, per-hour cost treated as the top of the price range. */
  expensivePerPerson?: number;
};

/**
 * Appetite for a place, from its tags.
 *
 * Matching tags are averaged rather than summed so that a place tagged with six
 * mild interests does not outrank one tagged with the traveller's single
 * passion. Explicit dislikes (negative weights) are folded into the same mean,
 * which lets "loves art, hates crowds" resolve sensibly on a blockbuster
 * gallery.
 */
export function interestScore(place: Place, preferences: Preferences): number {
  const weights = place.tags
    .map((tag) => preferences.interests[tag.toLowerCase()])
    .filter((weight): weight is number => typeof weight === 'number' && weight !== 0);

  if (weights.length === 0) return 0;
  const mean = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
  return clamp(mean, -1, 1);
}

export function ratingScore(place: Place): number {
  return clamp(place.rating / 5, 0, 1);
}

export function valueScore(place: Place, travelers: number, options: ScoreOptions = {}): number {
  const perPerson = Math.max(0, place.costPerPerson);
  if (perPerson === 0) return 1;
  const expensive = Math.max(1, options.expensivePerPerson ?? DEFAULT_EXPENSIVE_PER_PERSON);
  // Longer visits justify a higher ticket price, so value is cost per hour of experience.
  const hours = Math.max(0.5, place.dwellMinutes / 60);
  const costPerHour = perPerson / hours;
  const normalized = 1 - clamp(costPerHour / expensive, 0, 1);
  // A large party feels ticket prices more keenly.
  const partyPressure = travelers > 2 ? 0.9 : 1;
  return clamp(normalized * partyPressure, 0, 1);
}

export function scorePlace(place: Place, preferences: Preferences, options: ScoreOptions = {}): ScoreBreakdown {
  const interest = interestScore(place, preferences);
  const rating = ratingScore(place);
  const value = valueScore(place, preferences.travelers, options);
  const total =
    interest * SCORE_WEIGHTS.interest + rating * SCORE_WEIGHTS.rating + value * SCORE_WEIGHTS.value;
  return { interest, rating, value, total: round3(total) };
}

/** True when the traveller has explicitly ruled the place out. */
export function isExcluded(place: Place, preferences: Preferences): boolean {
  if (preferences.mustSeeIds.includes(place.id)) return false;
  if (preferences.avoidCategories.includes(place.category)) return true;
  return interestScore(place, preferences) <= -0.75;
}

/** Sentence fragments explaining why a place scored the way it did, for the UI. */
export function explainScore(place: Place, preferences: Preferences, options: ScoreOptions = {}): string[] {
  const breakdown = scorePlace(place, preferences, options);
  const reasons: string[] = [];

  const matched = place.tags.filter((tag) => (preferences.interests[tag.toLowerCase()] ?? 0) > 0.25);
  if (matched.length > 0) reasons.push(`matches your interest in ${formatList(matched)}`);

  if (breakdown.rating >= 0.88) reasons.push(`very highly rated (${place.rating.toFixed(1)}/5)`);
  if (place.costPerPerson === 0) reasons.push('free to enter');
  else if (breakdown.value >= 0.7) reasons.push('good value for the time it fills');

  if (preferences.mustSeeIds.includes(place.id)) reasons.unshift('you marked this a must-see');
  return reasons;
}

export function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
