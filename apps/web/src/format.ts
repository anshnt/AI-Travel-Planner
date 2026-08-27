import {
  formatClock,
  formatDuration,
  type MealKind,
  type PlaceCategory,
  type TravelMode,
  type WeatherCondition,
} from '@atp/core';

export { formatClock, formatDuration };

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
  JPY: '¥',
};

/** Money, with no decimals for currencies that do not use them. */
export function formatMoney(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const zeroDecimal = currency === 'JPY';
  const rounded = zeroDecimal ? Math.round(amount) : Math.round(amount * 100) / 100;
  const body = zeroDecimal
    ? rounded.toLocaleString('en-GB')
    : rounded.toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2 });
  return `${symbol}${body}`;
}

export function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export const MODE_ICONS: Record<TravelMode, string> = {
  walk: '\u{1F6B6}',
  cycle: '\u{1F6B4}',
  transit: '\u{1F687}',
  drive: '\u{1F697}',
};

export const WEATHER_ICONS: Record<WeatherCondition, string> = {
  clear: '☀️',
  'partly-cloudy': '⛅',
  cloudy: '☁️',
  rain: '\u{1F327}️',
  'heavy-rain': '\u{1F326}️',
  snow: '❄️',
  storm: '⛈️',
  fog: '\u{1F32B}️',
};

export const WEATHER_LABELS: Record<WeatherCondition, string> = {
  clear: 'Clear',
  'partly-cloudy': 'Partly cloudy',
  cloudy: 'Cloudy',
  rain: 'Rain',
  'heavy-rain': 'Heavy rain',
  snow: 'Snow',
  storm: 'Storms',
  fog: 'Fog',
};

/** Category colours, used consistently by the map pins and the timeline. */
export const CATEGORY_COLORS: Record<PlaceCategory, string> = {
  museum: '#7c6cf0',
  gallery: '#9a6cf0',
  landmark: '#e0705c',
  park: '#3fa86a',
  viewpoint: '#e8a33d',
  market: '#d95f8a',
  shopping: '#c07ad6',
  nightlife: '#5f6cd9',
  beach: '#3aa8bd',
  religious: '#b08d57',
  experience: '#4a9ad4',
  restaurant: '#d9694a',
  cafe: '#b5763f',
  lodging: '#6b7280',
};

export const MEAL_ICONS: Record<MealKind, string> = {
  breakfast: '\u{2615}',
  lunch: '\u{1F374}',
  dinner: '\u{1F37D}\u{FE0F}',
};

export const MEAL_LABELS: Record<MealKind, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

/**
 * Sequential numbers for the sightseeing stops, with meals skipped.
 *
 * Numbering by array position would leave visible gaps -- 1, 2, 3, lunch, 5 --
 * which reads as a missing stop rather than a meal.
 */
export function activityOrdinals(items: readonly { kind: string }[]): (number | null)[] {
  let next = 0;
  return items.map((item) => (item.kind === 'meal' ? null : (next += 1)));
}

export function categoryLabel(category: PlaceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** Today, as an ISO date, in the browser's own timezone. */
export function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
