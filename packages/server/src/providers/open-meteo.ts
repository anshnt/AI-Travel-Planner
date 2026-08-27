import type { Coord, DailyWeather, HourlyWeather, WeatherCondition } from '@atp/core';

import type { WeatherProvider } from './weather.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
  'precipitation_sum',
  'wind_speed_10m_max',
].join(',');

const HOURLY_FIELDS = ['temperature_2m', 'precipitation_probability', 'precipitation'].join(',');

/**
 * WMO weather codes, collapsed onto the conditions the planner reasons about.
 *
 * The planner does not care about the difference between drizzle and slight
 * rain -- it cares whether the traveller would rather be indoors -- so the 28
 * codes fold onto eight conditions. Freezing rain maps to rain rather than snow
 * because the relevant fact is wet, not white.
 */
const WMO_CONDITIONS: Record<number, WeatherCondition> = {
  0: 'clear',
  1: 'partly-cloudy',
  2: 'partly-cloudy',
  3: 'cloudy',
  45: 'fog',
  48: 'fog',
  51: 'rain',
  53: 'rain',
  55: 'rain',
  56: 'rain',
  57: 'rain',
  61: 'rain',
  63: 'rain',
  65: 'heavy-rain',
  66: 'rain',
  67: 'heavy-rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  80: 'rain',
  81: 'rain',
  82: 'heavy-rain',
  85: 'snow',
  86: 'snow',
  95: 'storm',
  96: 'storm',
  99: 'storm',
};

export function conditionFromWmoCode(code: number | null | undefined): WeatherCondition {
  if (code === null || code === undefined) return 'cloudy';
  return WMO_CONDITIONS[code] ?? 'cloudy';
}

/** The subset of the Open-Meteo response this provider reads. */
export type OpenMeteoResponse = {
  error?: boolean;
  reason?: string;
  daily?: {
    time: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    precipitation_sum?: (number | null)[];
    wind_speed_10m_max?: (number | null)[];
  };
  hourly?: {
    time: string[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    precipitation?: (number | null)[];
  };
};

/**
 * Turns one Open-Meteo response into `DailyWeather`, keyed by date.
 *
 * A pure function on purpose: it is where every mapping decision lives, and
 * every one of them is testable against a recorded response without touching the
 * network.
 */
export function toDailyWeather(response: OpenMeteoResponse): Map<string, DailyWeather> {
  const byDate = new Map<string, DailyWeather>();
  const daily = response.daily;
  if (!daily || !Array.isArray(daily.time)) return byDate;

  const hourlyByDate = groupHourly(response.hourly);

  daily.time.forEach((date, index) => {
    const tempMaxC = number(daily.temperature_2m_max?.[index], 18);
    const tempMinC = number(daily.temperature_2m_min?.[index], 10);
    // Open-Meteo reports probability as a percentage; the planner works in 0-1.
    const precipitationChance = clamp01(number(daily.precipitation_probability_max?.[index], 0) / 100);

    byDate.set(date, {
      date,
      condition: conditionFromWmoCode(daily.weather_code?.[index]),
      // Guard against a provider that returns them the wrong way round.
      tempMinC: Math.min(tempMinC, tempMaxC),
      tempMaxC: Math.max(tempMinC, tempMaxC),
      precipitationChance,
      precipitationMm: Math.max(0, number(daily.precipitation_sum?.[index], 0)),
      windKph: Math.max(0, number(daily.wind_speed_10m_max?.[index], 0)),
      ...(hourlyByDate.has(date) ? { hourly: hourlyByDate.get(date)! } : {}),
      source: 'forecast',
    });
  });

  return byDate;
}

/**
 * Splits the flat hourly arrays into one list per local calendar day.
 *
 * Open-Meteo returns local times as `2026-08-28T14:00` with no offset, which is
 * exactly what the planner wants: it works in local minutes and has no interest
 * in UTC.
 */
function groupHourly(hourly: OpenMeteoResponse['hourly']): Map<string, HourlyWeather[]> {
  const byDate = new Map<string, HourlyWeather[]>();
  if (!hourly || !Array.isArray(hourly.time)) return byDate;

  hourly.time.forEach((stamp, index) => {
    const [date, clock] = stamp.split('T');
    if (!date || !clock) return;
    const hour = Number(clock.slice(0, 2));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;

    const entries = byDate.get(date) ?? [];
    entries.push({
      hour,
      tempC: number(hourly.temperature_2m?.[index], 15),
      precipitationChance: clamp01(number(hourly.precipitation_probability?.[index], 0) / 100),
      precipitationMm: Math.max(0, number(hourly.precipitation?.[index], 0)),
    });
    byDate.set(date, entries);
  });

  for (const entries of byDate.values()) entries.sort((a, b) => a.hour - b.hour);
  return byDate;
}

export type OpenMeteoOptions = {
  /** Abandon a request after this long. A slow forecast is worse than none. */
  timeoutMs?: number;
  /** How long a response stays usable. Forecasts do not change by the minute. */
  cacheTtlMs?: number;
  /** Injectable for tests, which must never touch the network. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Live forecasts from Open-Meteo.
 *
 * Returns only the days it actually has. The forecast API covers a bounded
 * window -- roughly three months back and sixteen days forward -- and a traveller
 * planning next summer is outside it. Inventing numbers for those days and
 * calling them a forecast would be the wrong answer, so they simply come back
 * missing and the composed provider fills them from the climate model, labelled
 * as such.
 */
export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly name = 'open-meteo';

  private readonly cache = new Map<string, { at: number; value: Map<string, DailyWeather> }>();

  constructor(private readonly options: OpenMeteoOptions = {}) {}

  async forecast(coord: Coord, dates: readonly string[]): Promise<DailyWeather[]> {
    if (dates.length === 0) return [];

    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const key = cacheKey(coord, first, last);

    const cached = this.cache.get(key);
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (cached && Date.now() - cached.at < ttl) {
      return present(dates, cached.value);
    }

    const byDate = await this.request(coord, first, last);
    this.cache.set(key, { at: Date.now(), value: byDate });
    return present(dates, byDate);
  }

  /**
   * One request, with one clamped retry.
   *
   * Open-Meteo rejects a *range* rather than trimming it, so a trip that starts
   * next week and runs three weeks out gets nothing at all -- including for the
   * days it could have forecast. The rejection names the window it does cover, so
   * the honest response is to take it at its word, ask again for the overlap, and
   * let the climate model have the rest.
   */
  private async request(
    coord: Coord,
    from: string,
    to: string,
    mayRetry = true,
  ): Promise<Map<string, DailyWeather>> {
    const query = new URLSearchParams({
      latitude: coord.lat.toFixed(4),
      longitude: coord.lon.toFixed(4),
      start_date: from,
      end_date: to,
      daily: DAILY_FIELDS,
      hourly: HOURLY_FIELDS,
      // Local time is what the planner schedules in.
      timezone: 'auto',
    });

    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let payload: OpenMeteoResponse | null = null;
    let status = 0;
    try {
      const response = await doFetch(`${ENDPOINT}?${query}`, { signal: controller.signal });
      status = response.status;
      // A rejection carries its reason in the body, so read it before judging it.
      payload = (await response.json().catch(() => null)) as OpenMeteoResponse | null;
      if (response.ok && payload && !payload.error) return toDailyWeather(payload);
    } finally {
      clearTimeout(timer);
    }

    const reason = payload?.reason ?? `Open-Meteo returned ${status}`;
    const trimmed = mayRetry ? clampToAllowed(from, to, reason) : null;
    if (trimmed) return this.request(coord, trimmed.from, trimmed.to, false);

    throw new Error(reason);
  }
}

/**
 * The part of the requested range Open-Meteo says it can answer.
 *
 * Read out of the rejection itself -- "out of allowed range from 2026-05-26 to
 * 2026-09-11" -- rather than hardcoded, because a horizon baked into this file
 * would be wrong the day they change it, and wrong silently.
 */
function clampToAllowed(from: string, to: string, reason: string): { from: string; to: string } | null {
  const range = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(reason);
  if (!range) return null;

  const start = from > range[1]! ? from : range[1]!;
  const end = to < range[2]! ? to : range[2]!;
  if (start > end) return null;
  // Nothing was trimmed, so asking again would only fail the same way.
  if (start === from && end === to) return null;
  return { from: start, to: end };
}

/** Only the requested dates the provider actually has, in request order. */
function present(dates: readonly string[], byDate: Map<string, DailyWeather>): DailyWeather[] {
  return dates.flatMap((date) => {
    const entry = byDate.get(date);
    return entry ? [entry] : [];
  });
}

/**
 * Cache key rounded to about a kilometre.
 *
 * Two requests a few hundred metres apart get the same forecast anyway, and
 * Open-Meteo itself snaps to a grid -- so keying on exact coordinates would just
 * mean cache misses for identical answers.
 */
function cacheKey(coord: Coord, from: string, to: string): string {
  return `${coord.lat.toFixed(2)},${coord.lon.toFixed(2)},${from},${to}`;
}

function number(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
