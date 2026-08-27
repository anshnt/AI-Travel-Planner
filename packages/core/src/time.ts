import type { MinuteOfDay, OpeningHours, TimeWindow, Weekday } from './types.js';

export const MINUTES_PER_DAY = 1440;

/** Parses `"09:30"` into minutes since midnight. Accepts `"24:00"` for end-of-day. */
export function parseClock(clock: string): MinuteOfDay {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) throw new Error(`Invalid clock time: ${clock}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 48 || minutes > 59) throw new Error(`Clock time out of range: ${clock}`);
  return hours * 60 + minutes;
}

/** Formats minutes since midnight as `"09:30"`, wrapping times past midnight. */
export function formatClock(minute: MinuteOfDay): string {
  const normalized = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Formats a span of minutes as `"1h 20m"`, `"45m"`, or `"2h"`. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

/** Builds a window from clock strings, e.g. `window('10:00', '18:00')`. */
export function window(start: string, end: string): TimeWindow {
  return { start: parseClock(start), end: parseClock(end) };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertIsoDate(date: string): void {
  if (!ISO_DATE.test(date)) throw new Error(`Expected an ISO date (YYYY-MM-DD), got: ${date}`);
}

/**
 * Weekday for an ISO calendar date.
 *
 * Deliberately parsed as UTC: the string denotes a calendar day in the
 * destination, and UTC arithmetic keeps the weekday stable no matter what
 * timezone the process happens to run in.
 */
export function weekdayOf(date: string): Weekday {
  assertIsoDate(date);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${date}`);
  return parsed.getUTCDay() as Weekday;
}

export function addDays(date: string, days: number): string {
  assertIsoDate(date);
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetween(startDate: string, endDate: string): number {
  assertIsoDate(startDate);
  assertIsoDate(endDate);
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

/** Inclusive list of ISO dates from `startDate` to `endDate`. */
export function dateRange(startDate: string, endDate: string): string[] {
  const span = daysBetween(startDate, endDate);
  if (span < 0) throw new Error(`endDate ${endDate} precedes startDate ${startDate}`);
  return Array.from({ length: span + 1 }, (_, index) => addDays(startDate, index));
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function weekdayName(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday] ?? 'Unknown';
}

/**
 * The windows a place is open on a given date.
 *
 * A date-specific exception wins over the weekly pattern, which lets a caller
 * model a public-holiday closure as `exceptions: { '2026-01-01': [] }`.
 * Returned windows are sorted, clamped to sane values and merged where they
 * overlap, so downstream code can assume a clean, ordered list.
 */
export function openWindowsOn(hours: OpeningHours, date: string): TimeWindow[] {
  if (hours.exceptions && Object.prototype.hasOwnProperty.call(hours.exceptions, date)) {
    return normalizeWindows(hours.exceptions[date] ?? []);
  }
  if (hours.alwaysOpen) return [{ start: 0, end: MINUTES_PER_DAY }];
  if (!hours.weekly) return [];
  return normalizeWindows(hours.weekly[weekdayOf(date)] ?? []);
}

/** Sorts, drops empty spans, and merges touching or overlapping windows. */
export function normalizeWindows(windows: readonly TimeWindow[]): TimeWindow[] {
  const valid = windows
    .filter((slot) => slot.end > slot.start)
    .map((slot) => ({ start: slot.start, end: slot.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TimeWindow[] = [];
  for (const slot of valid) {
    const previous = merged[merged.length - 1];
    if (previous && slot.start <= previous.end) {
      previous.end = Math.max(previous.end, slot.end);
    } else {
      merged.push(slot);
    }
  }
  return merged;
}

export function isOpenAt(hours: OpeningHours, date: string, minute: MinuteOfDay): boolean {
  return openWindowsOn(hours, date).some((slot) => minute >= slot.start && minute < slot.end);
}

/** True when the place is shut for the whole date. */
export function isClosedAllDay(hours: OpeningHours, date: string): boolean {
  return openWindowsOn(hours, date).length === 0;
}

/**
 * Earliest start at or after `earliest` that fits a `durationMinutes` visit
 * inside one opening window, or `null` when the day cannot accommodate it.
 *
 * The visit may not straddle a gap between two windows — a museum that shuts
 * for lunch cannot be half-visited either side of the break.
 */
export function earliestFeasibleStart(
  hours: OpeningHours,
  date: string,
  earliest: MinuteOfDay,
  durationMinutes: number,
  latestEnd: MinuteOfDay,
): MinuteOfDay | null {
  for (const slot of openWindowsOn(hours, date)) {
    const start = Math.max(earliest, slot.start);
    const end = start + durationMinutes;
    if (end <= Math.min(slot.end, latestEnd)) return start;
  }
  return null;
}

/** Total minutes a place is open on a date; useful for ranking scarce access. */
export function openMinutesOn(hours: OpeningHours, date: string): number {
  return openWindowsOn(hours, date).reduce((sum, slot) => sum + (slot.end - slot.start), 0);
}

/** Renders a date's hours for display, e.g. `"10:00–14:00, 16:00–20:00"` or `"Closed"`. */
export function describeHours(hours: OpeningHours, date: string): string {
  const windows = openWindowsOn(hours, date);
  if (windows.length === 0) return 'Closed';
  if (windows.length === 1 && windows[0]!.start === 0 && windows[0]!.end >= MINUTES_PER_DAY) return 'Open 24 hours';
  return windows.map((slot) => `${formatClock(slot.start)}–${formatClock(slot.end)}`).join(', ');
}

/**
 * End of the opening window that contains `minute`, or `null` when the place is
 * shut at that moment. Lets the planner say *why* a visit sits where it does:
 * "it shuts at 18:00" is the answer to most scheduling questions.
 */
export function closingTimeAt(hours: OpeningHours, date: string, minute: MinuteOfDay): MinuteOfDay | null {
  const slot = openWindowsOn(hours, date).find((entry) => minute >= entry.start && minute < entry.end);
  return slot ? slot.end : null;
}

/** Start of the next opening window at or after `minute`, or `null` if there is none. */
export function nextOpeningAt(hours: OpeningHours, date: string, minute: MinuteOfDay): MinuteOfDay | null {
  const slot = openWindowsOn(hours, date).find((entry) => entry.start >= minute);
  return slot ? slot.start : null;
}

export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

export function clampToWindow(minute: MinuteOfDay, bounds: TimeWindow): MinuteOfDay {
  return Math.min(Math.max(minute, bounds.start), bounds.end);
}
