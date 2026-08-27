import { window, type OpeningHours, type TimeWindow, type Weekday } from '@atp/core';

const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const spread = (days: readonly Weekday[], windows: TimeWindow[]): Partial<Record<Weekday, TimeWindow[]>> =>
  Object.fromEntries(days.map((day) => [day, windows]));

/** Open the same hours every day of the week. */
export function daily(open: string, close: string): OpeningHours {
  return { weekly: spread(ALL_DAYS, [window(open, close)]) };
}

/** Open the same hours every day except the listed weekdays, which are closed. */
export function dailyExcept(closedDays: readonly Weekday[], open: string, close: string): OpeningHours {
  const openDays = ALL_DAYS.filter((day) => !closedDays.includes(day));
  return { weekly: { ...spread(openDays, [window(open, close)]), ...spread(closedDays, []) } };
}

/** Two separate windows a day, for places that shut over lunch or siesta. */
export function split(
  first: readonly [string, string],
  second: readonly [string, string],
  closedDays: readonly Weekday[] = [],
): OpeningHours {
  const openDays = ALL_DAYS.filter((day) => !closedDays.includes(day));
  const windows = [window(first[0], first[1]), window(second[0], second[1])];
  return { weekly: { ...spread(openDays, windows), ...spread(closedDays, []) } };
}

/** Different hours on weekdays and at the weekend. */
export function weekdayWeekend(
  weekdayHours: readonly [string, string],
  weekendHours: readonly [string, string],
): OpeningHours {
  return {
    weekly: {
      ...spread([1, 2, 3, 4, 5], [window(weekdayHours[0], weekdayHours[1])]),
      ...spread([0, 6], [window(weekendHours[0], weekendHours[1])]),
    },
  };
}

export const ALWAYS_OPEN: OpeningHours = { alwaysOpen: true };

export const MONDAY: Weekday = 1;
export const TUESDAY: Weekday = 2;
export const WEDNESDAY: Weekday = 3;
export const SUNDAY: Weekday = 0;

/** Adds date-specific closures, e.g. public holidays, to an existing pattern. */
export function withClosures(hours: OpeningHours, ...dates: string[]): OpeningHours {
  return {
    ...hours,
    exceptions: { ...hours.exceptions, ...Object.fromEntries(dates.map((date) => [date, []])) },
  };
}
