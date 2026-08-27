import { dayWeatherSeverity, formatClock, type DailyWeather, type HourlyWeather } from '@atp/core';
import type { CSSProperties } from 'react';

import { WEATHER_ICONS, WEATHER_LABELS } from '../format.js';

type Props = {
  weather: DailyWeather;
  /** The traveller's own day window, so the strip only shows hours they will be out in. */
  fromHour: number;
  toHour: number;
};

/** At or above this hourly chance, an hour counts as wet. */
const WET_HOUR = 0.4;

/**
 * Hourly chance of rain across the traveller's day.
 *
 * The point of showing hours rather than a single daily percentage is that the
 * planner reasons in hours: a "60% chance of rain" day where the rain lands
 * between two and four in the morning is a perfectly good day, and the strip is
 * what makes that visible next to the schedule it produced.
 */
export function WeatherStrip({ weather, fromHour, toHour }: Props) {
  const allHours = weather.hourly ?? [];
  const shown = allHours.filter((entry) => entry.hour >= fromHour && entry.hour <= toHour);
  const severity = dayWeatherSeverity(weather);
  const peak = wettestHour(allHours);

  // A whole-day condition of "heavy rain" against a strip of flat, dry bars
  // looks broken. It usually is not -- the rain is simply falling outside the
  // hours the traveller will be out -- but that has to be said out loud.
  const rainMissesTheDay =
    peak !== null && peak.precipitationChance >= WET_HOUR && (peak.hour < fromHour || peak.hour > toHour);

  return (
    <div className={`atp-weather atp-weather--${severity}`}>
      <div className="atp-weather__head">
        <span className="atp-weather__condition">
          {WEATHER_ICONS[weather.condition]} {WEATHER_LABELS[weather.condition]}
        </span>
        <span className="atp-weather__temps">
          {Math.round(weather.tempMinC)}&deg; to {Math.round(weather.tempMaxC)}&deg;
          {weather.windKph >= 38 ? ` · ${Math.round(weather.windKph)} km/h wind` : ''}
        </span>
      </div>

      {shown.length > 0 ? (
        <>
          <div className="atp-weather__bars" role="img" aria-label={describeStrip(weather, shown)}>
            {shown.map((entry) => (
              <span
                key={entry.hour}
                className={`atp-weather__bar${entry.precipitationChance >= WET_HOUR ? ' is-wet' : ''}`}
                style={{ '--rain': `${Math.round(entry.precipitationChance * 100)}%` } as CSSProperties}
                title={`${formatClock(entry.hour * 60)} · ${Math.round(entry.precipitationChance * 100)}% rain · ${Math.round(entry.tempC)}°`}
              />
            ))}
          </div>
          <div className="atp-weather__axis" aria-hidden="true">
            <span>{formatClock(fromHour * 60)}</span>
            <span>rain by the hour</span>
            <span>{formatClock((toHour + 1) * 60)}</span>
          </div>
        </>
      ) : null}

      {rainMissesTheDay && peak ? (
        <p className="atp-weather__note">
          Wettest around {formatClock(peak.hour * 60)} &mdash; outside the hours you are out.
        </p>
      ) : null}
    </div>
  );
}

function wettestHour(hours: readonly HourlyWeather[]): HourlyWeather | null {
  return hours.reduce<HourlyWeather | null>(
    (worst, entry) => (!worst || entry.precipitationChance > worst.precipitationChance ? entry : worst),
    null,
  );
}

function describeStrip(weather: DailyWeather, hours: readonly HourlyWeather[]): string {
  const peak = wettestHour(hours);
  if (!peak || peak.precipitationChance < 0.25) {
    return `Little chance of rain while you are out, ${Math.round(weather.tempMinC)} to ${Math.round(weather.tempMaxC)} degrees.`;
  }
  return `Wettest around ${formatClock(peak.hour * 60)}, ${Math.round(peak.precipitationChance * 100)}% chance of rain.`;
}
