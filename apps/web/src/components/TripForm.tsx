import type { Pace, TravelMode } from '@atp/core';

import type { Destination, DestinationSummary, PlanFormState } from '../api.js';
import { formatMoney } from '../format.js';

type Props = {
  destinations: DestinationSummary[];
  destination: Destination | null;
  form: PlanFormState;
  onChange: (patch: Partial<PlanFormState>) => void;
  onSubmit: () => void;
  planning: boolean;
};

const PACES: { value: Pace; label: string; hint: string }[] = [
  { value: 'relaxed', label: 'Relaxed', hint: 'up to 3 stops a day' },
  { value: 'balanced', label: 'Balanced', hint: 'up to 5 stops a day' },
  { value: 'packed', label: 'Packed', hint: 'up to 7 stops a day' },
];

const MODES: { value: TravelMode; label: string }[] = [
  { value: 'walk', label: 'Walk' },
  { value: 'transit', label: 'Transit' },
  { value: 'cycle', label: 'Cycle' },
  { value: 'drive', label: 'Drive' },
];

/** How many interest chips to offer before hiding the long tail. */
const INTEREST_LIMIT = 18;

export function TripForm({ destinations, destination, form, onChange, onSubmit, planning }: Props) {
  const interests = (destination?.interests ?? []).slice(0, INTEREST_LIMIT);
  const nights = Math.max(
    0,
    Math.round(
      (Date.parse(`${form.endDate}T00:00:00Z`) - Date.parse(`${form.startDate}T00:00:00Z`)) / 86_400_000,
    ),
  );
  const currency = destination?.currency ?? 'EUR';

  return (
    <form
      className="atp-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="atp-field">
        <label htmlFor="destination">Destination</label>
        <select
          id="destination"
          value={form.destinationId}
          onChange={(event) => onChange({ destinationId: event.target.value })}
        >
          {destinations.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}, {option.country}
            </option>
          ))}
        </select>
      </div>

      <div className="atp-field-row">
        <div className="atp-field">
          <label htmlFor="startDate">Arrive</label>
          <input
            id="startDate"
            type="date"
            value={form.startDate}
            max={form.endDate}
            onChange={(event) => onChange({ startDate: event.target.value })}
          />
        </div>
        <div className="atp-field">
          <label htmlFor="endDate">Leave</label>
          <input
            id="endDate"
            type="date"
            value={form.endDate}
            min={form.startDate}
            onChange={(event) => onChange({ endDate: event.target.value })}
          />
        </div>
      </div>

      <div className="atp-field-row">
        <div className="atp-field">
          <label htmlFor="travelers">Travellers</label>
          <input
            id="travelers"
            type="number"
            min={1}
            max={20}
            value={form.travelers}
            onChange={(event) => onChange({ travelers: clampInt(event.target.value, 1, 20, form.travelers) })}
          />
        </div>
        <div className="atp-field">
          <label htmlFor="budget">
            Budget <span className="atp-hint">total, {nights + 1} days</span>
          </label>
          <input
            id="budget"
            type="number"
            min={0}
            step={destination?.currency === 'JPY' ? 1000 : 10}
            value={form.budgetTotal}
            onChange={(event) => onChange({ budgetTotal: Math.max(0, Number(event.target.value) || 0) })}
          />
        </div>
      </div>

      {destination ? (
        <p className="atp-hint atp-hint--block">
          A comfortable day in {destination.name} runs about{' '}
          {formatMoney(destination.suggestedDailyBudget * form.travelers, currency)} for {form.travelers}
          {form.travelers === 1 ? ' person' : ' people'}.
        </p>
      ) : null}

      <fieldset className="atp-field">
        <legend>Pace</legend>
        <div className="atp-segmented">
          {PACES.map((option) => (
            <button
              key={option.value}
              type="button"
              className={form.pace === option.value ? 'is-active' : ''}
              aria-pressed={form.pace === option.value}
              title={option.hint}
              onClick={() => onChange({ pace: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="atp-field-row">
        <div className="atp-field">
          <label htmlFor="dayStart">Out by</label>
          <input
            id="dayStart"
            type="time"
            value={form.dayStart}
            onChange={(event) => onChange({ dayStart: event.target.value })}
          />
        </div>
        <div className="atp-field">
          <label htmlFor="dayEnd">Back by</label>
          <input
            id="dayEnd"
            type="time"
            value={form.dayEnd}
            onChange={(event) => onChange({ dayEnd: event.target.value })}
          />
        </div>
      </div>

      <fieldset className="atp-field">
        <legend>Getting around</legend>
        <div className="atp-chips">
          {MODES.map((mode) => {
            const active = form.preferredModes.includes(mode.value);
            return (
              <button
                key={mode.value}
                type="button"
                className={`atp-chip${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => onChange({ preferredModes: toggleMode(form.preferredModes, mode.value) })}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="atp-field">
        <label htmlFor="maxWalk">
          Longest walk you would accept <span className="atp-hint">{form.maxWalkMinutes} min</span>
        </label>
        <input
          id="maxWalk"
          type="range"
          min={5}
          max={60}
          step={1}
          value={form.maxWalkMinutes}
          onChange={(event) => onChange({ maxWalkMinutes: Number(event.target.value) })}
        />
      </div>

      <fieldset className="atp-field">
        <legend>
          What are you here for? <span className="atp-hint">tap once to like, twice to avoid</span>
        </legend>
        <div className="atp-chips">
          {interests.map((tag) => {
            const weight = form.interests[tag] ?? 0;
            const state = weight > 0 ? 'is-liked' : weight < 0 ? 'is-avoided' : '';
            return (
              <button
                key={tag}
                type="button"
                className={`atp-chip ${state}`}
                aria-pressed={weight !== 0}
                onClick={() => onChange({ interests: cycleInterest(form.interests, tag) })}
              >
                {weight > 0 ? '+ ' : weight < 0 ? '− ' : ''}
                {tag}
              </button>
            );
          })}
        </div>
      </fieldset>

      {destination ? (
        <div className="atp-field">
          <label htmlFor="lodging">Base yourself near</label>
          <select
            id="lodging"
            value={form.lodgingPlaceId ?? ''}
            onChange={(event) => onChange({ lodgingPlaceId: event.target.value || undefined })}
          >
            <option value="">City centre</option>
            {destination.places
              .filter((place) => place.category !== 'restaurant' && place.category !== 'cafe')
              .map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
          </select>
        </div>
      ) : null}

      <button type="submit" className="atp-submit" disabled={planning}>
        {planning ? 'Planning…' : 'Plan my trip'}
      </button>
    </form>
  );
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toggleMode(modes: TravelMode[], mode: TravelMode): TravelMode[] {
  if (modes.includes(mode)) {
    const next = modes.filter((entry) => entry !== mode);
    // Something has to be possible, so never leave the traveller with no way to move.
    return next.length > 0 ? next : modes;
  }
  return [...modes, mode];
}

/** Neutral, then liked, then avoided, then back to neutral. */
function cycleInterest(interests: Record<string, number>, tag: string): Record<string, number> {
  const next = { ...interests };
  const current = next[tag] ?? 0;
  if (current === 0) next[tag] = 0.9;
  else if (current > 0) next[tag] = -0.8;
  else delete next[tag];
  return next;
}
