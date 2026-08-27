import { describe, expect, it } from 'vitest';

import {
  dayWeatherSeverity,
  describeWetSpell,
  rainRiskBetween,
  rainSeverity,
  tempBetween,
  weatherFit,
  wetSpells,
} from './weather.js';
import type { DailyWeather, HourlyWeather, Place } from './types.js';

function hourly(spec: Partial<Record<number, { risk?: number; tempC?: number }>>): HourlyWeather[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    tempC: spec[hour]?.tempC ?? 18,
    precipitationChance: spec[hour]?.risk ?? 0.05,
    precipitationMm: (spec[hour]?.risk ?? 0) > 0.4 ? 2 : 0,
  }));
}

function weather(overrides: Partial<DailyWeather> = {}): DailyWeather {
  return {
    date: '2026-05-11',
    condition: 'partly-cloudy',
    tempMinC: 14,
    tempMaxC: 22,
    precipitationChance: 0.1,
    precipitationMm: 0,
    windKph: 12,
    ...overrides,
  };
}

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'indoor'>): Place {
  return {
    name: overrides.id,
    category: 'landmark',
    coord: { lat: 41.4, lon: 2.17 },
    dwellMinutes: 60,
    costPerPerson: 0,
    rating: 4,
    tags: [],
    openingHours: { alwaysOpen: true },
    ...overrides,
  };
}

describe('rainRiskBetween', () => {
  const forecast = weather({
    precipitationChance: 0.5,
    hourly: hourly({ 13: { risk: 0.8 }, 14: { risk: 0.9 }, 15: { risk: 0.7 } }),
  });

  it('takes the worst hour in the slot, not the average', () => {
    // 12:00-15:00 spans a dry hour and two very wet ones.
    expect(rainRiskBetween(forecast, 12 * 60, 15 * 60)).toBe(0.9);
  });

  it('reports a dry slot as dry', () => {
    expect(rainRiskBetween(forecast, 9 * 60, 11 * 60)).toBe(0.05);
  });

  it('covers the hour a slot starts in even when it is under an hour long', () => {
    expect(rainRiskBetween(forecast, 14 * 60 + 10, 14 * 60 + 40)).toBe(0.9);
  });

  it('does not bleed into the hour a slot ends exactly on', () => {
    expect(rainRiskBetween(forecast, 11 * 60, 13 * 60)).toBe(0.05);
  });

  it('falls back to the daily figure with no hourly detail', () => {
    expect(rainRiskBetween(weather({ precipitationChance: 0.42 }), 9 * 60, 12 * 60)).toBe(0.42);
  });
});

describe('tempBetween', () => {
  it('averages the hours in the slot', () => {
    const forecast = weather({ hourly: hourly({ 9: { tempC: 10 }, 10: { tempC: 20 } }) });
    expect(tempBetween(forecast, 9 * 60, 11 * 60)).toBe(15);
  });

  it('falls back to the midpoint of the daily range', () => {
    expect(tempBetween(weather({ tempMinC: 10, tempMaxC: 20 }), 9 * 60, 11 * 60)).toBe(15);
  });
});

describe('rainSeverity', () => {
  it('ignores a light chance of rain', () => {
    expect(rainSeverity(0.1)).toBe(0);
    expect(rainSeverity(0.2)).toBe(0);
  });

  it('saturates once rain is a near certainty', () => {
    expect(rainSeverity(0.75)).toBe(1);
    expect(rainSeverity(0.95)).toBe(1);
  });

  it('rises in between', () => {
    expect(rainSeverity(0.5)).toBeGreaterThan(0);
    expect(rainSeverity(0.5)).toBeLessThan(1);
    expect(rainSeverity(0.65)).toBeGreaterThan(rainSeverity(0.4));
  });
});

describe('weatherFit', () => {
  const park = place({ id: 'park', category: 'park', indoor: false });
  const gallery = place({ id: 'gallery', category: 'gallery', indoor: true });

  it('is neutral with no forecast at all', () => {
    expect(weatherFit(park, undefined, 10 * 60, 11 * 60)).toEqual({ fit: 0, cautions: [] });
  });

  it('is neutral for both on a mild dry day', () => {
    const mild = weather({ hourly: hourly({}) });
    expect(weatherFit(park, mild, 10 * 60, 11 * 60).fit).toBe(0);
    expect(weatherFit(gallery, mild, 10 * 60, 11 * 60).fit).toBe(0);
  });

  it('penalises the park and rewards the gallery in a downpour', () => {
    const wet = weather({
      condition: 'rain',
      precipitationChance: 0.85,
      hourly: hourly({ 14: { risk: 0.85 }, 15: { risk: 0.85 } }),
    });
    expect(weatherFit(park, wet, 14 * 60, 16 * 60).fit).toBeLessThan(-0.9);
    expect(weatherFit(gallery, wet, 14 * 60, 16 * 60).fit).toBeGreaterThan(0.4);
  });

  it('judges the same place differently at different hours of the same day', () => {
    const showery = weather({
      precipitationChance: 0.6,
      hourly: hourly({ 14: { risk: 0.8 }, 15: { risk: 0.8 } }),
    });
    const dryMorning = weatherFit(park, showery, 9 * 60, 11 * 60).fit;
    const wetAfternoon = weatherFit(park, showery, 14 * 60, 16 * 60).fit;
    expect(dryMorning).toBeGreaterThan(wetAfternoon);
  });

  it('penalises an outdoor stop in fierce heat and shelters indoors from it', () => {
    const scorching = weather({
      tempMinC: 28,
      tempMaxC: 40,
      hourly: hourly({ 14: { tempC: 39 }, 15: { tempC: 39 } }),
    });
    expect(weatherFit(park, scorching, 14 * 60, 16 * 60).fit).toBeLessThan(-0.5);
    expect(weatherFit(gallery, scorching, 14 * 60, 16 * 60).fit).toBeGreaterThan(0);
  });

  it('penalises an outdoor stop in hard cold', () => {
    const freezing = weather({ tempMinC: -6, tempMaxC: -2, hourly: hourly({ 10: { tempC: -4 } }) });
    expect(weatherFit(park, freezing, 10 * 60, 11 * 60).fit).toBeLessThan(-0.4);
  });

  it('penalises an exposed viewpoint in high wind but not a sheltered street', () => {
    const gale = weather({ windKph: 68, hourly: hourly({}) });
    const viewpoint = place({ id: 'viewpoint', category: 'viewpoint', indoor: false });
    const street = place({ id: 'street', category: 'landmark', indoor: false });
    expect(weatherFit(viewpoint, gale, 10 * 60, 11 * 60).fit).toBeLessThan(0);
    expect(weatherFit(street, gale, 10 * 60, 11 * 60).fit).toBe(0);
  });

  it('treats a cold beach as a wasted trip, not a compromise', () => {
    const chilly = weather({ tempMinC: 8, tempMaxC: 13, hourly: hourly({ 11: { tempC: 12 } }) });
    const beach = place({ id: 'beach', category: 'beach', indoor: false });
    const park2 = place({ id: 'park2', category: 'park', indoor: false });
    expect(weatherFit(beach, chilly, 11 * 60, 13 * 60).fit).toBeLessThan(
      weatherFit(park2, chilly, 11 * 60, 13 * 60).fit,
    );
  });

  it('never scores below -1 or above 1', () => {
    const awful = weather({
      condition: 'storm',
      tempMinC: -12,
      tempMaxC: -8,
      precipitationChance: 1,
      windKph: 110,
      hourly: hourly({ 10: { risk: 1, tempC: -10 } }),
    });
    const beach = place({ id: 'beach', category: 'beach', indoor: false });
    expect(weatherFit(beach, awful, 10 * 60, 12 * 60).fit).toBeGreaterThanOrEqual(-1);
    expect(weatherFit(place({ id: 'g', indoor: true }), awful, 10 * 60, 12 * 60).fit).toBeLessThanOrEqual(1);
  });

  it('explains itself in words a traveller can act on', () => {
    const wet = weather({ precipitationChance: 0.8, hourly: hourly({ 14: { risk: 0.8 } }) });
    expect(weatherFit(park, wet, 14 * 60, 15 * 60).cautions.join(' ')).toMatch(
      /outdoors with a 80% chance of rain around 14:00/,
    );
    expect(weatherFit(gallery, wet, 14 * 60, 15 * 60).cautions.join(' ')).toMatch(/indoors, which suits/);
  });
});

describe('dayWeatherSeverity', () => {
  it('calls a dry mild day fine', () => {
    expect(dayWeatherSeverity(weather())).toBe('fine');
  });

  it('calls a showery or blustery day mixed', () => {
    expect(dayWeatherSeverity(weather({ precipitationChance: 0.35 }))).toBe('mixed');
    expect(dayWeatherSeverity(weather({ windKph: 50 }))).toBe('mixed');
  });

  it('calls a storm, a soaking, real heat or real cold poor', () => {
    expect(dayWeatherSeverity(weather({ condition: 'storm' }))).toBe('poor');
    expect(dayWeatherSeverity(weather({ precipitationChance: 0.8 }))).toBe('poor');
    expect(dayWeatherSeverity(weather({ tempMaxC: 39 }))).toBe('poor');
    expect(dayWeatherSeverity(weather({ tempMinC: -3 }))).toBe('poor');
  });

  it('treats an absent forecast as no reason to worry', () => {
    expect(dayWeatherSeverity(undefined)).toBe('fine');
  });
});

describe('wetSpells', () => {
  it('groups consecutive wet hours into one spell', () => {
    const forecast = weather({
      hourly: hourly({ 13: { risk: 0.6 }, 14: { risk: 0.8 }, 15: { risk: 0.5 } }),
    });
    const spells = wetSpells(forecast);
    expect(spells).toHaveLength(1);
    expect(spells[0]).toMatchObject({ fromMinute: 13 * 60, toMinute: 16 * 60, peakRisk: 0.8 });
    expect(describeWetSpell(spells[0]!)).toBe('13:00 to 16:00');
  });

  it('keeps two separate showers separate', () => {
    const forecast = weather({
      hourly: hourly({ 9: { risk: 0.6 }, 16: { risk: 0.7 } }),
    });
    expect(wetSpells(forecast)).toHaveLength(2);
  });

  it('finds nothing on a dry day, or with no hourly detail', () => {
    expect(wetSpells(weather({ hourly: hourly({}) }))).toEqual([]);
    expect(wetSpells(weather())).toEqual([]);
    expect(wetSpells(undefined)).toEqual([]);
  });
});
