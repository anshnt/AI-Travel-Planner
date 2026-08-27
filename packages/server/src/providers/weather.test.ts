import type { Coord, DailyWeather } from '@atp/core';
import { describe, expect, it } from 'vitest';

import { FallbackWeatherProvider, SyntheticWeatherProvider, type WeatherProvider } from './weather.js';

const BARCELONA = { lat: 41.3874, lon: 2.1686 };
const DATES = ['2026-08-28', '2026-08-29', '2026-08-30'];

function forecastFor(date: string): DailyWeather {
  return {
    date,
    source: 'forecast',
    condition: 'clear',
    tempMinC: 20,
    tempMaxC: 28,
    precipitationChance: 0.1,
    precipitationMm: 0,
    windKph: 12,
  };
}

/** A live provider that answers for some dates and knows nothing of the rest. */
function covering(dates: readonly string[], calls: string[][] = []): WeatherProvider {
  return {
    name: 'stub',
    async forecast(_coord: Coord, asked: readonly string[]): Promise<DailyWeather[]> {
      calls.push([...asked]);
      return asked.filter((date) => dates.includes(date)).map(forecastFor);
    },
  };
}

function failing(error: Error): WeatherProvider {
  return {
    name: 'stub',
    async forecast(): Promise<DailyWeather[]> {
      throw error;
    },
  };
}

describe('SyntheticWeatherProvider', () => {
  const provider = new SyntheticWeatherProvider();

  it('admits what it is', async () => {
    const [day] = await provider.forecast(BARCELONA, ['2026-08-28']);
    expect(day!.source).toBe('climate-model');
  });

  it('is the same forecast every time it is asked', async () => {
    const first = await provider.forecast(BARCELONA, DATES);
    const second = await new SyntheticWeatherProvider().forecast(BARCELONA, DATES);
    expect(second).toEqual(first);
  });

  it('produces a coherent day', async () => {
    for (const day of await provider.forecast(BARCELONA, DATES)) {
      expect(day.tempMinC).toBeLessThanOrEqual(day.tempMaxC);
      expect(day.precipitationChance).toBeGreaterThanOrEqual(0);
      expect(day.precipitationChance).toBeLessThanOrEqual(1);
      expect(day.hourly).toHaveLength(24);
    }
  });

  it('gives each day its own weather', async () => {
    // The hash has to avalanche on the last byte of its key, because the date is
    // the tail of every key here. Without a final mixing step consecutive days
    // came back within a tenth of a degree of one another and one wet Tuesday
    // made the whole week wet -- which is not day-to-day variation at all.
    const threeWeeks = Array.from({ length: 21 }, (_, index) => `2026-05-${String(index + 1).padStart(2, '0')}`);

    for (const coord of [BARCELONA, { lat: 35.01, lon: 135.76 }, { lat: -37.81, lon: 144.96 }]) {
      const days = await provider.forecast(coord, threeWeeks);
      const maxima = days.map((day) => day.tempMaxC);
      const steps = maxima.slice(1).map((value, index) => Math.abs(value - maxima[index]!));
      const meanStep = steps.reduce((sum, step) => sum + step, 0) / steps.length;

      expect(meanStep).toBeGreaterThan(1);
      expect(new Set(maxima).size).toBeGreaterThan(15);
      expect(new Set(days.map((day) => day.condition)).size).toBeGreaterThan(2);
    }
  });

  it('knows which hemisphere it is in', async () => {
    // Late August: summer in Barcelona, winter in Melbourne.
    const [north] = await provider.forecast(BARCELONA, ['2026-08-28']);
    const [south] = await provider.forecast({ lat: -37.81, lon: 144.96 }, ['2026-08-28']);
    expect(north!.tempMaxC).toBeGreaterThan(south!.tempMaxC);
  });
});

describe('FallbackWeatherProvider', () => {
  it('names both providers, so a response can be traced to what produced it', () => {
    const provider = new FallbackWeatherProvider(covering(DATES));
    expect(provider.name).toBe('stub+synthetic');
  });

  it('passes the live forecast straight through when it covers the trip', async () => {
    const provider = new FallbackWeatherProvider(covering(DATES));
    const forecast = await provider.forecast(BARCELONA, DATES);

    expect(forecast.map((day) => day.date)).toEqual(DATES);
    expect(forecast.every((day) => day.source === 'forecast')).toBe(true);
  });

  it('fills the days beyond the forecast horizon and labels them as estimates', async () => {
    // The real case: a trip that starts inside the forecast window and runs past it.
    const provider = new FallbackWeatherProvider(covering(['2026-08-28']));
    const forecast = await provider.forecast(BARCELONA, DATES);

    expect(forecast.map((day) => day.date)).toEqual(DATES);
    expect(forecast.map((day) => day.source)).toEqual(['forecast', 'climate-model', 'climate-model']);
  });

  it('keeps planning when the live provider fails, and says why', async () => {
    const failures: unknown[] = [];
    const provider = new FallbackWeatherProvider(
      failing(new Error('network unreachable')),
      new SyntheticWeatherProvider(),
      (error) => failures.push(error),
    );

    const forecast = await provider.forecast(BARCELONA, DATES);

    expect(forecast.map((day) => day.date)).toEqual(DATES);
    expect(forecast.every((day) => day.source === 'climate-model')).toBe(true);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('network unreachable');
  });

  it('never lets a live failure reach the caller', async () => {
    const provider = new FallbackWeatherProvider(failing(new Error('boom')));
    await expect(provider.forecast(BARCELONA, ['2026-08-28'])).resolves.toHaveLength(1);
  });

  it('only asks the climate model about the days that are missing', async () => {
    const climateCalls: string[][] = [];
    const provider = new FallbackWeatherProvider(covering(['2026-08-28', '2026-08-29']), {
      name: 'climate',
      async forecast(_coord, asked) {
        climateCalls.push([...asked]);
        return asked.map((date) => ({ ...forecastFor(date), source: 'climate-model' as const }));
      },
    });

    await provider.forecast(BARCELONA, DATES);
    expect(climateCalls).toEqual([['2026-08-30']]);
  });

  it('does not call the climate model at all when nothing is missing', async () => {
    const climateCalls: string[][] = [];
    const provider = new FallbackWeatherProvider(covering(DATES), {
      name: 'climate',
      async forecast(_coord, asked) {
        climateCalls.push([...asked]);
        return [];
      },
    });

    await provider.forecast(BARCELONA, DATES);
    expect(climateCalls).toEqual([]);
  });

  it('overrides the label on anything the climate model returns', async () => {
    // A stand-in that forgets to label itself must not be able to pass an
    // estimate off as a forecast.
    const provider = new FallbackWeatherProvider(covering([]), {
      name: 'careless',
      async forecast(_coord, asked) {
        return asked.map(forecastFor); // claims 'forecast'
      },
    });

    const forecast = await provider.forecast(BARCELONA, DATES);
    expect(forecast.every((day) => day.source === 'climate-model')).toBe(true);
  });

  it('drops days nobody asked for', async () => {
    const provider = new FallbackWeatherProvider({
      name: 'overeager',
      async forecast(): Promise<DailyWeather[]> {
        return ['2026-08-28', '2026-09-01'].map(forecastFor);
      },
    });

    const forecast = await provider.forecast(BARCELONA, ['2026-08-28']);
    expect(forecast.map((day) => day.date)).toEqual(['2026-08-28']);
  });
});
