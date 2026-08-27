import { clamp } from './scoring.js';
import { formatClock } from './time.js';
import type { DailyWeather, MinuteOfDay, Place, PlaceCategory } from './types.js';

/**
 * Weather thresholds, in one place.
 *
 * These are comfort thresholds, not meteorological ones: the question is never
 * "is it raining" but "would a reasonable person rather be indoors right now".
 */
export const WEATHER_THRESHOLDS = {
  /** Below this chance of rain, nobody changes their plans. */
  rainTolerated: 0.2,
  /** At or above this chance, being outdoors is a poor call. */
  rainSevere: 0.75,
  /** Above this, standing about outside stops being pleasant. */
  hotC: 30,
  /** Below this, likewise. */
  coldC: 5,
  /** Beaches and swimming need real warmth to be worth the trip. */
  beachWarmC: 21,
  /** Above this, exposed viewpoints and seafronts are unpleasant. */
  windyKph: 38,
} as const;

/** Categories whose whole appeal is exposure to the elements. */
const EXPOSED_CATEGORIES: ReadonlySet<PlaceCategory> = new Set(['viewpoint', 'beach', 'park']);

export type WeatherSeverity = 'fine' | 'mixed' | 'poor';

export type WeatherFit = {
  /**
   * How well the place suits the conditions during its slot: -1 (actively the
   * wrong thing to be doing) through 0 (neutral) to +1 (exactly the right call).
   */
  fit: number;
  /** Plain-language cautions, for the traveller rather than the optimiser. */
  cautions: string[];
};

const NEUTRAL_FIT: WeatherFit = { fit: 0, cautions: [] };

/** Negating a clamped zero yields -0, which compares badly. Normalise it away. */
const signless = (value: number): number => (value === 0 ? 0 : value);

/** The hours a `[start, end)` slot touches, clamped to a single day. */
function hoursSpanned(start: MinuteOfDay, end: MinuteOfDay): number[] {
  const firstHour = Math.max(0, Math.floor(start / 60));
  const lastHour = Math.min(23, Math.floor((Math.max(end, start + 1) - 1) / 60));
  const hours: number[] = [];
  for (let hour = firstHour; hour <= lastHour; hour += 1) hours.push(hour);
  return hours;
}

/**
 * Worst chance of rain during a slot.
 *
 * Deliberately the worst rather than the average: a two-hour outdoor visit with
 * a downpour in the middle of it is a wet visit, and averaging that against the
 * dry half hour either side would hide exactly the problem worth avoiding.
 * Falls back to the whole-day figure when no hourly detail is available.
 */
export function rainRiskBetween(weather: DailyWeather, start: MinuteOfDay, end: MinuteOfDay): number {
  if (!weather.hourly || weather.hourly.length === 0) return weather.precipitationChance;
  const byHour = new Map(weather.hourly.map((entry) => [entry.hour, entry]));
  const risks = hoursSpanned(start, end)
    .map((hour) => byHour.get(hour)?.precipitationChance)
    .filter((risk): risk is number => typeof risk === 'number');
  return risks.length === 0 ? weather.precipitationChance : Math.max(...risks);
}

/** Mean temperature across a slot, from hourly detail where available. */
export function tempBetween(weather: DailyWeather, start: MinuteOfDay, end: MinuteOfDay): number {
  const midpoint = (weather.tempMinC + weather.tempMaxC) / 2;
  if (!weather.hourly || weather.hourly.length === 0) return midpoint;
  const byHour = new Map(weather.hourly.map((entry) => [entry.hour, entry]));
  const temps = hoursSpanned(start, end)
    .map((hour) => byHour.get(hour)?.tempC)
    .filter((temp): temp is number => typeof temp === 'number');
  return temps.length === 0 ? midpoint : temps.reduce((sum, temp) => sum + temp, 0) / temps.length;
}

/** 0 (dry enough) to 1 (thoroughly wet), on the comfort thresholds above. */
export function rainSeverity(risk: number): number {
  const { rainTolerated, rainSevere } = WEATHER_THRESHOLDS;
  return clamp((risk - rainTolerated) / (rainSevere - rainTolerated), 0, 1);
}

/**
 * How well a place suits the weather during the slot it has been given.
 *
 * This is what lets the planner do the genuinely useful thing: not "avoid rainy
 * days" but "put the gallery in the wet hours and the park in the dry ones".
 */
export function weatherFit(
  place: Place,
  weather: DailyWeather | undefined,
  start: MinuteOfDay,
  end: MinuteOfDay,
): WeatherFit {
  if (!weather) return NEUTRAL_FIT;

  const risk = rainRiskBetween(weather, start, end);
  const wet = rainSeverity(risk);
  const temp = tempBetween(weather, start, end);
  const cautions: string[] = [];

  if (place.indoor) {
    // Being under cover while it rains is the right call, and worth a nudge --
    // but only a nudge, or every wet day becomes a museum crawl.
    if (wet > 0.25) cautions.push(`indoors, which suits the ${Math.round(risk * 100)}% chance of rain`);
    const heatRelief = clamp((temp - WEATHER_THRESHOLDS.hotC) / 8, 0, 1);
    return { fit: signless(clamp(wet * 0.5 + heatRelief * 0.3, 0, 1)), cautions };
  }

  let penalty = wet;
  if (wet > 0.3) {
    cautions.push(`outdoors with a ${Math.round(risk * 100)}% chance of rain around ${formatClock(start)}`);
  }

  const heat = clamp((temp - WEATHER_THRESHOLDS.hotC) / 8, 0, 1);
  if (heat > 0) {
    penalty += heat * 0.8;
    if (heat > 0.25) cautions.push(`${Math.round(temp)}°C at that hour, with little shade`);
  }

  const cold = clamp((WEATHER_THRESHOLDS.coldC - temp) / 8, 0, 1);
  if (cold > 0) {
    penalty += cold * 0.8;
    if (cold > 0.25) cautions.push(`only ${Math.round(temp)}°C at that hour`);
  }

  if (EXPOSED_CATEGORIES.has(place.category)) {
    const windy = clamp((weather.windKph - WEATHER_THRESHOLDS.windyKph) / 30, 0, 1);
    if (windy > 0) {
      penalty += windy * 0.6;
      if (windy > 0.3) cautions.push(`exposed, and it is blowing ${Math.round(weather.windKph)} km/h`);
    }
  }

  // A beach in the cold is not a bad-weather compromise, it is a wasted trip.
  if (place.category === 'beach' && temp < WEATHER_THRESHOLDS.beachWarmC) {
    const chill = clamp((WEATHER_THRESHOLDS.beachWarmC - temp) / 10, 0, 1);
    penalty += chill;
    if (chill > 0.3) cautions.push(`too cool for the beach at ${Math.round(temp)}°C`);
  }

  return { fit: signless(-clamp(penalty, 0, 1)), cautions };
}

/** A day's overall outlook, for the headline in the UI. */
export function dayWeatherSeverity(weather: DailyWeather | undefined): WeatherSeverity {
  if (!weather) return 'fine';
  const wet = rainSeverity(weather.precipitationChance);
  const extremeHeat = weather.tempMaxC > WEATHER_THRESHOLDS.hotC + 4;
  const extremeCold = weather.tempMinC < WEATHER_THRESHOLDS.coldC - 4;
  if (wet > 0.6 || weather.condition === 'storm' || extremeHeat || extremeCold) return 'poor';
  if (wet > 0.2 || weather.windKph > WEATHER_THRESHOLDS.windyKph) return 'mixed';
  return 'fine';
}

export type WetSpell = { fromMinute: MinuteOfDay; toMinute: MinuteOfDay; peakRisk: number };

/**
 * Contiguous stretches of the day likely to be wet.
 *
 * The planner does not use these directly -- it works slot by slot -- but they
 * are what makes the day note readable: "rain likely 13:00 to 16:00" says more
 * than a 55% daily figure ever could.
 */
export function wetSpells(weather: DailyWeather | undefined, minRisk = 0.4): WetSpell[] {
  if (!weather?.hourly || weather.hourly.length === 0) return [];
  const sorted = [...weather.hourly].sort((a, b) => a.hour - b.hour);
  const spells: WetSpell[] = [];
  let open: WetSpell | null = null;

  for (const entry of sorted) {
    if (entry.precipitationChance >= minRisk) {
      if (open && open.toMinute === entry.hour * 60) {
        open.toMinute = (entry.hour + 1) * 60;
        open.peakRisk = Math.max(open.peakRisk, entry.precipitationChance);
      } else {
        open = {
          fromMinute: entry.hour * 60,
          toMinute: (entry.hour + 1) * 60,
          peakRisk: entry.precipitationChance,
        };
        spells.push(open);
      }
    } else {
      open = null;
    }
  }
  return spells;
}

export function describeWetSpell(spell: WetSpell): string {
  return `${formatClock(spell.fromMinute)} to ${formatClock(spell.toMinute)}`;
}
