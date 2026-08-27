import type { Coord, DailyWeather, HourlyWeather, WeatherCondition } from '@atp/core';

export interface WeatherProvider {
  readonly name: string;
  /** One entry per requested date, in the same order. */
  forecast(coord: Coord, dates: readonly string[]): Promise<DailyWeather[]>;
}

/** FNV-1a, so the same coordinate and date always produce the same forecast. */
function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Deterministic pseudo-random in [0, 1) derived from a string key. */
function noise(key: string): number {
  return hash(key) / 0x1_0000_0000;
}

function conditionFor(precipitationChance: number, precipitationMm: number, tempMaxC: number): WeatherCondition {
  if (precipitationMm > 14) return 'storm';
  if (precipitationMm > 6) return tempMaxC < 2 ? 'snow' : 'heavy-rain';
  if (precipitationChance > 0.45) return tempMaxC < 2 ? 'snow' : 'rain';
  if (precipitationChance > 0.28) return 'cloudy';
  if (precipitationChance > 0.15) return 'partly-cloudy';
  return 'clear';
}

/**
 * A climate-shaped stand-in for a real forecast.
 *
 * It is not a prediction and does not pretend to be: it exists so the planner's
 * weather reasoning can be developed, demonstrated and tested offline and
 * deterministically. Latitude sets the annual mean and the size of the seasonal
 * swing, the month sets where in that swing the date falls, and a hash of the
 * coordinate and date supplies the day-to-day variation. Swap in
 * `OpenMeteoWeatherProvider` for anything a traveller will actually rely on.
 */
export class SyntheticWeatherProvider implements WeatherProvider {
  readonly name = 'synthetic';

  async forecast(coord: Coord, dates: readonly string[]): Promise<DailyWeather[]> {
    return dates.map((date) => this.forDate(coord, date));
  }

  private forDate(coord: Coord, date: string): DailyWeather {
    const month = Number(date.slice(5, 7));
    const key = `${coord.lat.toFixed(3)},${coord.lon.toFixed(3)},${date}`;

    const absLat = Math.abs(coord.lat);
    const annualMean = 29 - 0.32 * absLat;
    const seasonalSwing = 2 + 0.26 * absLat;
    // Peak summer is July up north, January down south.
    const peakMonth = coord.lat >= 0 ? 7 : 1;
    const seasonal = Math.cos(((month - peakMonth) / 12) * 2 * Math.PI);

    const dailyWobble = (noise(`t:${key}`) - 0.5) * 7;
    const meanTemp = annualMean + seasonalSwing * seasonal + dailyWobble;
    const spread = 5 + noise(`s:${key}`) * 5;

    const tempMinC = round1(meanTemp - spread / 2);
    const tempMaxC = round1(meanTemp + spread / 2);

    // Wetter in the cool half of the year, which is true of most temperate cities.
    const wetSeasonBias = 0.34 - 0.16 * seasonal;
    const precipitationChance = clamp01(wetSeasonBias + (noise(`p:${key}`) - 0.5) * 0.6);
    const precipitationMm =
      precipitationChance < 0.25 ? 0 : round1(precipitationChance * (2 + noise(`m:${key}`) * 18));
    const windKph = Math.round(5 + noise(`w:${key}`) * 28);

    return {
      date,
      condition: conditionFor(precipitationChance, precipitationMm, tempMaxC),
      tempMinC,
      tempMaxC,
      precipitationChance: round2(precipitationChance),
      precipitationMm,
      windKph,
      hourly: this.hourly(key, tempMinC, tempMaxC, precipitationChance, precipitationMm),
    };
  }

  /**
   * Hourly detail, so the planner can tell "wet morning, dry afternoon" from
   * "wet all day". Rain is placed in one contiguous block rather than smeared
   * across the day, because a plan that can dodge a shower is only possible if
   * the forecast says when the shower is.
   */
  private hourly(
    key: string,
    tempMinC: number,
    tempMaxC: number,
    precipitationChance: number,
    precipitationMm: number,
  ): HourlyWeather[] {
    const wetStart = Math.floor(noise(`h:${key}`) * 18);
    const wetLength = precipitationChance < 0.25 ? 0 : 2 + Math.floor(noise(`l:${key}`) * 7);

    return Array.from({ length: 24 }, (_, hour) => {
      // Coldest around 05:00, warmest around 15:00.
      const diurnal = -Math.cos(((hour - 5) / 24) * 2 * Math.PI);
      const tempC = round1(tempMinC + ((tempMaxC - tempMinC) * (diurnal + 1)) / 2);
      const wet = hour >= wetStart && hour < wetStart + wetLength;
      return {
        hour,
        tempC,
        precipitationChance: wet ? round2(clamp01(precipitationChance + 0.3)) : round2(precipitationChance * 0.25),
        precipitationMm: wet && wetLength > 0 ? round1(precipitationMm / wetLength) : 0,
      };
    });
  }
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
