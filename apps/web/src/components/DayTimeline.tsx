import type { DayPlan, Itinerary } from '@atp/core';

import {
  CATEGORY_COLORS,
  MODE_ICONS,
  WEATHER_ICONS,
  WEATHER_LABELS,
  categoryLabel,
  formatClock,
  formatDayLabel,
  formatDuration,
  formatMoney,
} from '../format.js';
import { WeatherStrip } from './WeatherStrip.js';

type Props = {
  day: DayPlan;
  currency: string;
  /** The traveller's day window in hours, used to frame the weather strip. */
  dayWindowHours: [number, number];
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string | null) => void;
};

export function DayTimeline({ day, currency, dayWindowHours, selectedPlaceId, onSelectPlace }: Props) {
  return (
    <section className="atp-day" aria-label={`Plan for ${formatDayLabel(day.date)}`}>
      <header className="atp-day__header">
        <h3>{formatDayLabel(day.date)}</h3>
        {day.weather ? (
          <span className="atp-day__weather" title={WEATHER_LABELS[day.weather.condition]}>
            {WEATHER_ICONS[day.weather.condition]} {Math.round(day.weather.tempMaxC)}&deg;
            {day.weather.precipitationChance >= 0.25 ? (
              <span className="atp-day__rain">{Math.round(day.weather.precipitationChance * 100)}% rain</span>
            ) : null}
          </span>
        ) : null}
      </header>

      {day.weather ? (
        <WeatherStrip weather={day.weather} fromHour={dayWindowHours[0]} toHour={dayWindowHours[1]} />
      ) : null}

      {day.items.length === 0 ? (
        <p className="atp-empty">Nothing fitted this day.</p>
      ) : (
        <ol className="atp-timeline">
          {day.items.map((item, index) => {
            const selected = item.placeId === selectedPlaceId;
            return (
              <li key={item.placeId}>
                {item.arrival && item.arrival.minutes > 0 ? (
                  <p className="atp-leg">
                    {MODE_ICONS[item.arrival.mode]} {formatDuration(item.arrival.minutes)}
                    {item.arrival.cost > 0 ? ` · ${formatMoney(item.arrival.cost, currency)}` : ''}
                  </p>
                ) : null}

                <button
                  type="button"
                  className={`atp-stop${selected ? ' atp-stop--selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => onSelectPlace(selected ? null : item.placeId)}
                >
                  <span
                    className="atp-stop__index"
                    style={{ background: CATEGORY_COLORS[item.place.category] ?? '#6b7280' }}
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="atp-stop__body">
                    <span className="atp-stop__title">
                      <span className="atp-stop__name">{item.place.name}</span>
                      <span className="atp-stop__time">
                        {formatClock(item.start)}&ndash;{formatClock(item.end)}
                      </span>
                    </span>
                    <span className="atp-stop__meta">
                      {categoryLabel(item.place.category)}
                      {' · '}
                      {item.cost > 0 ? formatMoney(item.cost, currency) : 'free'}
                      {item.place.indoor ? ' · indoor' : ' · outdoor'}
                    </span>
                    {item.cautions.length > 0 ? (
                      <span className="atp-stop__caution">{item.cautions.join(' · ')}</span>
                    ) : null}
                    {selected && item.reasons.length > 0 ? (
                      <span className="atp-stop__reasons">{item.reasons.join(' · ')}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {day.returnToBase && day.returnToBase.minutes > 0 ? (
        <p className="atp-leg atp-leg--home">
          {MODE_ICONS[day.returnToBase.mode]} {formatDuration(day.returnToBase.minutes)} back to base
        </p>
      ) : null}

      <dl className="atp-day__totals">
        <div>
          <dt>Spend</dt>
          <dd>{formatMoney(day.totals.cost, currency)}</dd>
        </div>
        <div>
          <dt>On the move</dt>
          <dd>{formatDuration(day.totals.travelMinutes)}</dd>
        </div>
        <div>
          <dt>At places</dt>
          <dd>{formatDuration(day.totals.activeMinutes)}</dd>
        </div>
      </dl>

      {day.notes.length > 0 ? (
        <ul className="atp-notes">
          {day.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TripSummary({ itinerary, budgetTotal }: { itinerary: Itinerary; budgetTotal: number }) {
  const spent = itinerary.totals.cost;
  const usedFraction = budgetTotal > 0 ? Math.min(1, spent / budgetTotal) : 0;
  const overspent = spent > budgetTotal + 0.001;

  return (
    <section className="atp-summary" aria-label="Trip summary">
      <div className="atp-summary__figures">
        <div>
          <span className="atp-summary__value">{itinerary.totals.placesVisited}</span>
          <span className="atp-summary__label">stops</span>
        </div>
        <div>
          <span className="atp-summary__value">{formatMoney(spent, itinerary.currency)}</span>
          <span className="atp-summary__label">of {formatMoney(budgetTotal, itinerary.currency)}</span>
        </div>
        <div>
          <span className="atp-summary__value">{formatDuration(itinerary.totals.travelMinutes)}</span>
          <span className="atp-summary__label">travelling</span>
        </div>
        <div>
          <span className="atp-summary__value">{formatDuration(itinerary.totals.walkMinutes)}</span>
          <span className="atp-summary__label">on foot</span>
        </div>
      </div>

      <div
        className={`atp-meter${overspent ? ' atp-meter--over' : ''}`}
        role="meter"
        aria-valuenow={Math.round(usedFraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Budget used"
      >
        <div className="atp-meter__fill" style={{ width: `${usedFraction * 100}%` }} />
      </div>

      {itinerary.rejected.length > 0 ? (
        <details className="atp-rejected">
          <summary>{itinerary.rejected.length} candidates left out</summary>
          <ul>
            {itinerary.rejected.map((rejection) => (
              <li key={rejection.placeId}>
                <strong>{rejection.name}</strong>
                <span> &mdash; {rejection.detail ?? rejection.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
