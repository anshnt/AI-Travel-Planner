import { describe, expect, it } from 'vitest';

import {
  conditionFromWmoCode,
  OpenMeteoWeatherProvider,
  toDailyWeather,
  type OpenMeteoResponse,
} from './open-meteo.js';

const BARCELONA = { lat: 41.3874, lon: 2.1686 };

/**
 * A real Open-Meteo response, recorded verbatim.
 *
 * Two days of Barcelona in late August: hot, cloudy, a wet patch in the small
 * hours of the first day and nothing after it. Recorded rather than invented so
 * the transform is tested against the shape the API actually sends -- percentages
 * for probability, millimetres for rain, local timestamps with no offset -- and
 * tested without touching the network.
 */
const RECORDED: OpenMeteoResponse = {
  daily: {
    time: ['2026-08-28', '2026-08-29'],
    weather_code: [3, 3],
    temperature_2m_max: [30.6, 29.1],
    temperature_2m_min: [24.8, 20.6],
    precipitation_probability_max: [43, 0],
    precipitation_sum: [0.2, 0.0],
    wind_speed_10m_max: [17.6, 16.2],
  },
  hourly: {
    time: [
      '2026-08-28T00:00', '2026-08-28T01:00', '2026-08-28T02:00', '2026-08-28T03:00',
      '2026-08-28T04:00', '2026-08-28T05:00', '2026-08-28T06:00', '2026-08-28T07:00',
      '2026-08-28T08:00', '2026-08-28T09:00', '2026-08-28T10:00', '2026-08-28T11:00',
      '2026-08-28T12:00', '2026-08-28T13:00', '2026-08-28T14:00', '2026-08-28T15:00',
      '2026-08-28T16:00', '2026-08-28T17:00', '2026-08-28T18:00', '2026-08-28T19:00',
      '2026-08-28T20:00', '2026-08-28T21:00', '2026-08-28T22:00', '2026-08-28T23:00',
      '2026-08-29T00:00', '2026-08-29T01:00', '2026-08-29T02:00', '2026-08-29T03:00',
      '2026-08-29T04:00', '2026-08-29T05:00', '2026-08-29T06:00', '2026-08-29T07:00',
      '2026-08-29T08:00', '2026-08-29T09:00', '2026-08-29T10:00', '2026-08-29T11:00',
      '2026-08-29T12:00', '2026-08-29T13:00', '2026-08-29T14:00', '2026-08-29T15:00',
      '2026-08-29T16:00', '2026-08-29T17:00', '2026-08-29T18:00', '2026-08-29T19:00',
      '2026-08-29T20:00', '2026-08-29T21:00', '2026-08-29T22:00', '2026-08-29T23:00'
    ],
    temperature_2m: [
      26.8, 26.5, 26.3, 25.9, 25.5, 25.7, 25.8, 24.9, 24.8, 25.0, 25.5, 26.1, 26.8, 27.8, 29.2, 30.0,
      30.6, 30.2, 30.3, 29.9, 29.0, 27.5, 26.2, 25.1, 24.2, 24.0, 22.7, 21.8, 21.2, 20.8, 20.8, 20.6,
      20.7, 22.2, 24.2, 26.7, 28.3, 29.1, 28.9, 28.9, 28.9, 28.7, 28.2, 27.7, 27.1, 26.3, 25.6, 25.0
    ],
    precipitation_probability: [
      8, 10, 33, 43, 35, 10, 5, 0, 3, 5, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ],
    precipitation: [
      0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    ],
  },
};

/** A `fetch` that answers from memory and records the URLs it was given. */
function stubFetch(
  payload: unknown,
  options: { status?: number; urls?: string[] } = {},
): typeof fetch {
  return (async (input: unknown) => {
    options.urls?.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('conditionFromWmoCode', () => {
  it('collapses the code families onto the conditions the planner reasons about', () => {
    expect(conditionFromWmoCode(0)).toBe('clear');
    expect(conditionFromWmoCode(2)).toBe('partly-cloudy');
    expect(conditionFromWmoCode(3)).toBe('cloudy');
    expect(conditionFromWmoCode(45)).toBe('fog');
    expect(conditionFromWmoCode(61)).toBe('rain');
    expect(conditionFromWmoCode(65)).toBe('heavy-rain');
    expect(conditionFromWmoCode(75)).toBe('snow');
    expect(conditionFromWmoCode(95)).toBe('storm');
  });

  it('treats freezing rain as rain, because the relevant fact is wet rather than white', () => {
    expect(conditionFromWmoCode(56)).toBe('rain');
    expect(conditionFromWmoCode(57)).toBe('rain');
    expect(conditionFromWmoCode(66)).toBe('rain');
    expect(conditionFromWmoCode(67)).toBe('heavy-rain');
  });

  it('falls back to cloudy for a code it does not know', () => {
    expect(conditionFromWmoCode(1234)).toBe('cloudy');
    expect(conditionFromWmoCode(null)).toBe('cloudy');
    expect(conditionFromWmoCode(undefined)).toBe('cloudy');
  });
});

describe('toDailyWeather', () => {
  const byDate = toDailyWeather(RECORDED);

  it('reads every day the response covers', () => {
    expect([...byDate.keys()]).toEqual(['2026-08-28', '2026-08-29']);
  });

  it('labels the days as a real forecast', () => {
    for (const entry of byDate.values()) expect(entry.source).toBe('forecast');
  });

  it('converts probability from a percentage to the 0-1 the planner works in', () => {
    expect(byDate.get('2026-08-28')!.precipitationChance).toBeCloseTo(0.43, 5);
    expect(byDate.get('2026-08-29')!.precipitationChance).toBe(0);
  });

  it('carries the daily numbers across unchanged', () => {
    expect(byDate.get('2026-08-28')).toMatchObject({
      condition: 'cloudy',
      tempMinC: 24.8,
      tempMaxC: 30.6,
      precipitationMm: 0.2,
      windKph: 17.6,
    });
  });

  it('splits the flat hourly arrays into one full local day each', () => {
    const first = byDate.get('2026-08-28')!.hourly!;
    expect(first).toHaveLength(24);
    expect(first.map((hour) => hour.hour)).toEqual([...Array(24).keys()]);
    expect(byDate.get('2026-08-29')!.hourly).toHaveLength(24);
  });

  it('keeps the hourly rain where the forecast put it', () => {
    const first = byDate.get('2026-08-28')!.hourly!;
    // The wet patch is 02:00-05:00; the afternoon is dry, which is exactly the
    // distinction the planner needs to schedule around a shower.
    expect(first[3]!.precipitationChance).toBeCloseTo(0.43, 5);
    expect(first[15]!.precipitationChance).toBe(0);
    expect(first[4]!.precipitationMm).toBeCloseTo(0.1, 5);
    expect(first[16]!.tempC).toBe(30.6);
  });

  it('returns nothing for a response with no daily block', () => {
    expect(toDailyWeather({}).size).toBe(0);
    expect(toDailyWeather({ error: true, reason: 'out of range' }).size).toBe(0);
  });

  it('leaves a day without hourly detail rather than inventing it', () => {
    const entry = toDailyWeather({ daily: { time: ['2026-08-28'], weather_code: [0] } }).get('2026-08-28')!;
    expect(entry.hourly).toBeUndefined();
    expect(entry.condition).toBe('clear');
  });

  it('corrects a minimum and maximum sent the wrong way round', () => {
    const entry = toDailyWeather({
      daily: { time: ['2026-08-28'], temperature_2m_max: [11], temperature_2m_min: [22] },
    }).get('2026-08-28')!;
    expect(entry.tempMinC).toBe(11);
    expect(entry.tempMaxC).toBe(22);
  });

  it('substitutes plausible numbers for missing ones rather than emitting NaN', () => {
    const entry = toDailyWeather({
      daily: {
        time: ['2026-08-28'],
        temperature_2m_max: [null],
        precipitation_probability_max: [null],
        precipitation_sum: [null],
        wind_speed_10m_max: [null],
      },
    }).get('2026-08-28')!;
    for (const value of [entry.tempMinC, entry.tempMaxC, entry.precipitationChance, entry.precipitationMm, entry.windKph]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('OpenMeteoWeatherProvider', () => {
  it('asks for the requested range in local time', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED, { urls }) });

    await provider.forecast(BARCELONA, ['2026-08-28', '2026-08-29']);

    expect(urls).toHaveLength(1);
    const query = new URL(urls[0]!).searchParams;
    expect(query.get('start_date')).toBe('2026-08-28');
    expect(query.get('end_date')).toBe('2026-08-29');
    expect(query.get('timezone')).toBe('auto');
    expect(Number(query.get('latitude'))).toBeCloseTo(BARCELONA.lat, 3);
    expect(query.get('daily')).toContain('precipitation_probability_max');
    expect(query.get('hourly')).toContain('precipitation');
  });

  it('returns the requested days in request order', async () => {
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED) });
    const forecast = await provider.forecast(BARCELONA, ['2026-08-28', '2026-08-29']);
    expect(forecast.map((day) => day.date)).toEqual(['2026-08-28', '2026-08-29']);
  });

  it('returns only the days it actually has, without padding the gap', async () => {
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED) });
    // Open-Meteo's window ends where it ends; a day past it comes back missing.
    const forecast = await provider.forecast(BARCELONA, ['2026-08-28', '2026-08-29', '2026-08-30']);
    expect(forecast.map((day) => day.date)).toEqual(['2026-08-28', '2026-08-29']);
  });

  it('ignores days it was not asked for', async () => {
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED) });
    const forecast = await provider.forecast(BARCELONA, ['2026-08-29']);
    expect(forecast.map((day) => day.date)).toEqual(['2026-08-29']);
  });

  it('does not call out at all for an empty range', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED, { urls }) });
    expect(await provider.forecast(BARCELONA, [])).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('serves a repeated range from the cache', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch(RECORDED, { urls }) });

    await provider.forecast(BARCELONA, ['2026-08-28', '2026-08-29']);
    await provider.forecast(BARCELONA, ['2026-08-28', '2026-08-29']);
    // A few hundred metres away is the same forecast, and the same cache entry.
    await provider.forecast({ lat: BARCELONA.lat + 0.001, lon: BARCELONA.lon }, ['2026-08-28', '2026-08-29']);

    expect(urls).toHaveLength(1);
  });

  it('re-asks once the cache entry is stale', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({ cacheTtlMs: 0, fetchImpl: stubFetch(RECORDED, { urls }) });
    await provider.forecast(BARCELONA, ['2026-08-28']);
    await provider.forecast(BARCELONA, ['2026-08-28']);
    expect(urls).toHaveLength(2);
  });

  it('asks again for the days the window does cover', async () => {
    // The real behaviour: Open-Meteo rejects the whole range over one bad day,
    // naming the window it can answer. Refusing to ask again would cost the
    // traveller a real forecast for the days that were always available.
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const asked = new URL(url).searchParams.get('end_date');
      if (asked === '2026-09-15') {
        return new Response(
          JSON.stringify({
            error: true,
            reason: "Parameter 'end_date' is out of allowed range from 2026-05-26 to 2026-09-11",
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ daily: { time: ['2026-09-10', '2026-09-11'], weather_code: [0, 61] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenMeteoWeatherProvider({ fetchImpl });
    const forecast = await provider.forecast(BARCELONA, ['2026-09-10', '2026-09-11', '2026-09-15']);

    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get('end_date')).toBe('2026-09-11');
    expect(forecast.map((day) => day.date)).toEqual(['2026-09-10', '2026-09-11']);
    expect(forecast.every((day) => day.source === 'forecast')).toBe(true);
  });

  it('does not ask twice when the trip is wholly outside the window', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: stubFetch(
        {
          error: true,
          reason: "Parameter 'start_date' is out of allowed range from 2026-05-26 to 2026-09-11",
        },
        { status: 400, urls },
      ),
    });

    await expect(provider.forecast(BARCELONA, ['2027-05-11', '2027-05-12'])).rejects.toThrow(/allowed range/);
    expect(urls).toHaveLength(1);
  });

  it('does not ask twice when a rejection explains nothing', async () => {
    const urls: string[] = [];
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: stubFetch({ error: true, reason: 'Something went wrong' }, { status: 400, urls }),
    });

    await expect(provider.forecast(BARCELONA, ['2026-08-28'])).rejects.toThrow('Something went wrong');
    expect(urls).toHaveLength(1);
  });

  it('reports a failure that arrives as something other than JSON', async () => {
    const htmlFetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: htmlFetch });
    await expect(provider.forecast(BARCELONA, ['2026-08-28'])).rejects.toThrow(/502/);
  });

  it('treats an error body on a 200 as the failure it is', async () => {
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: stubFetch({
        error: true,
        reason: "Parameter 'start_date' is out of allowed range from 2026-05-26 to 2026-09-11",
      }),
    });
    await expect(provider.forecast(BARCELONA, ['2027-05-11'])).rejects.toThrow(/out of allowed range/);
  });

  it('reports a failed status', async () => {
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: stubFetch({}, { status: 503 }) });
    await expect(provider.forecast(BARCELONA, ['2026-08-28'])).rejects.toThrow(/503/);
  });

  it('gives up on a request that hangs', async () => {
    // A fetch that never answers, only listens for the abort the provider sends.
    const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const provider = new OpenMeteoWeatherProvider({ timeoutMs: 5, fetchImpl: hangingFetch });
    await expect(provider.forecast(BARCELONA, ['2026-08-28'])).rejects.toThrow(/aborted/);
  });
});
