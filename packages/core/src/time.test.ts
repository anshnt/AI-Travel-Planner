import { describe, expect, it } from 'vitest';

import {
  addDays,
  dateRange,
  daysBetween,
  describeHours,
  earliestFeasibleStart,
  formatClock,
  formatDuration,
  isClosedAllDay,
  isOpenAt,
  normalizeWindows,
  openMinutesOn,
  openWindowsOn,
  parseClock,
  weekdayName,
  weekdayOf,
  window,
} from './time.js';
import type { OpeningHours } from './types.js';

describe('clock parsing and formatting', () => {
  it('round-trips clock strings', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('24:00')).toBe(1440);
    expect(formatClock(570)).toBe('09:30');
    expect(formatClock(0)).toBe('00:00');
  });

  it('wraps times past midnight when formatting', () => {
    expect(formatClock(1440)).toBe('00:00');
    expect(formatClock(1500)).toBe('01:00');
  });

  it('rejects nonsense', () => {
    expect(() => parseClock('9:5')).toThrow();
    expect(() => parseClock('noon')).toThrow();
    expect(() => parseClock('10:75')).toThrow();
  });

  it('formats durations the way a human would say them', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(80)).toBe('1h 20m');
    expect(formatDuration(-5)).toBe('0m');
  });
});

describe('calendar helpers', () => {
  it('finds the weekday regardless of process timezone', () => {
    // 2026-03-16 is a Monday.
    expect(weekdayOf('2026-03-16')).toBe(1);
    expect(weekdayName(weekdayOf('2026-03-16'))).toBe('Monday');
    expect(weekdayOf('2026-03-15')).toBe(0);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('measures and enumerates inclusive ranges', () => {
    expect(daysBetween('2026-03-16', '2026-03-20')).toBe(4);
    expect(dateRange('2026-03-16', '2026-03-18')).toEqual(['2026-03-16', '2026-03-17', '2026-03-18']);
    expect(dateRange('2026-03-16', '2026-03-16')).toEqual(['2026-03-16']);
    expect(() => dateRange('2026-03-18', '2026-03-16')).toThrow();
  });

  it('rejects malformed dates', () => {
    expect(() => weekdayOf('16-03-2026')).toThrow();
    expect(() => addDays('2026-3-1', 1)).toThrow();
  });
});

describe('normalizeWindows', () => {
  it('sorts, drops empties and merges overlaps', () => {
    expect(
      normalizeWindows([
        { start: 600, end: 720 },
        { start: 300, end: 300 },
        { start: 700, end: 900 },
      ]),
    ).toEqual([{ start: 600, end: 900 }]);
  });

  it('keeps a genuine lunch break separate', () => {
    expect(
      normalizeWindows([
        { start: 600, end: 840 },
        { start: 960, end: 1200 },
      ]),
    ).toEqual([
      { start: 600, end: 840 },
      { start: 960, end: 1200 },
    ]);
  });
});

describe('openWindowsOn', () => {
  const hours: OpeningHours = {
    weekly: {
      1: [], // closed Mondays, as museums are
      2: [window('10:00', '18:00')],
      3: [window('10:00', '14:00'), window('16:00', '20:00')],
    },
    exceptions: {
      '2026-03-17': [], // public holiday closure on a Tuesday
      '2026-03-18': [window('10:00', '12:00')],
    },
  };

  it('reads the weekly pattern', () => {
    expect(openWindowsOn(hours, '2026-03-24')).toEqual([{ start: 600, end: 1080 }]); // Tuesday
    expect(openWindowsOn(hours, '2026-03-16')).toEqual([]); // Monday
  });

  it('lets a date exception override the weekly pattern', () => {
    expect(openWindowsOn(hours, '2026-03-17')).toEqual([]);
    expect(isClosedAllDay(hours, '2026-03-17')).toBe(true);
    expect(openWindowsOn(hours, '2026-03-18')).toEqual([{ start: 600, end: 720 }]);
  });

  it('treats alwaysOpen as the full day', () => {
    expect(openWindowsOn({ alwaysOpen: true }, '2026-03-16')).toEqual([{ start: 0, end: 1440 }]);
    expect(describeHours({ alwaysOpen: true }, '2026-03-16')).toBe('Open 24 hours');
  });

  it('reports no hours at all as closed rather than open', () => {
    expect(openWindowsOn({}, '2026-03-16')).toEqual([]);
    expect(isClosedAllDay({}, '2026-03-16')).toBe(true);
  });

  it('answers point-in-time questions, exclusive of the closing minute', () => {
    expect(isOpenAt(hours, '2026-03-24', 600)).toBe(true);
    expect(isOpenAt(hours, '2026-03-24', 1079)).toBe(true);
    expect(isOpenAt(hours, '2026-03-24', 1080)).toBe(false);
    expect(isOpenAt(hours, '2026-03-25', 900)).toBe(false); // in the lunch gap
  });

  it('sums open minutes and describes split hours', () => {
    expect(openMinutesOn(hours, '2026-03-25')).toBe(240 + 240);
    expect(describeHours(hours, '2026-03-25')).toBe('10:00–14:00, 16:00–20:00');
    expect(describeHours(hours, '2026-03-16')).toBe('Closed');
  });
});

describe('earliestFeasibleStart', () => {
  const split: OpeningHours = { weekly: { 3: [window('10:00', '14:00'), window('16:00', '20:00')] } };
  const wednesday = '2026-03-25';

  it('waits for opening time when the traveller arrives early', () => {
    expect(earliestFeasibleStart(split, wednesday, 8 * 60, 60, 22 * 60)).toBe(600);
  });

  it('starts on arrival when already open', () => {
    expect(earliestFeasibleStart(split, wednesday, 11 * 60, 60, 22 * 60)).toBe(660);
  });

  it('refuses to straddle a lunch closure and rolls to the next window', () => {
    // Arriving 13:30 with a 90-minute visit cannot finish before the 14:00 break.
    expect(earliestFeasibleStart(split, wednesday, 13 * 60 + 30, 90, 22 * 60)).toBe(16 * 60);
  });

  it('returns null when the visit cannot finish before closing', () => {
    expect(earliestFeasibleStart(split, wednesday, 19 * 60 + 30, 90, 22 * 60)).toBeNull();
  });

  it('respects the traveller latest-end bound, not just closing time', () => {
    expect(earliestFeasibleStart(split, wednesday, 16 * 60, 120, 17 * 60)).toBeNull();
    expect(earliestFeasibleStart(split, wednesday, 16 * 60, 60, 17 * 60)).toBe(16 * 60);
  });

  it('returns null on a closed day', () => {
    expect(earliestFeasibleStart(split, '2026-03-24', 9 * 60, 30, 22 * 60)).toBeNull();
  });
});
