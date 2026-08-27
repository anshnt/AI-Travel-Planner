import type { Change, Itinerary, ScheduledItem } from '@atp/core';
import { useState } from 'react';

import { formatClock, formatDayLabel } from '../format.js';

export type DisruptionAction =
  | { kind: 'running-late'; minutes: number }
  | { kind: 'place-closed'; placeId: string; date?: string }
  | { kind: 'pin'; placeId: string }
  | { kind: 'unpin'; placeId: string }
  | { kind: 'move'; placeId: string; toDate: string }
  | { kind: 'drop'; placeId: string };

type Props = {
  itinerary: Itinerary;
  /** The stop the traveller has selected, if any: the target of the stop actions. */
  selected: { item: ScheduledItem; date: string } | null;
  pinned: readonly string[];
  changes: readonly Change[];
  summary: readonly string[];
  busy: boolean;
  onDisrupt: (action: DisruptionAction, now?: { date: string; minute: string }) => void;
  onDismiss: () => void;
};

const LATE_OPTIONS = [30, 60, 90];

/**
 * The controls that make the plan a living thing rather than a printout.
 *
 * Two kinds of action, deliberately separated. "Running late" is about the trip
 * and needs to know where the traveller is; the rest are about one stop and are
 * only offered once a stop is selected, because "close this" with nothing
 * selected has no meaning.
 */
export function DisruptionBar({
  itinerary,
  selected,
  pinned,
  changes,
  summary,
  busy,
  onDisrupt,
  onDismiss,
}: Props) {
  const [atDate, setAtDate] = useState(itinerary.days[0]?.date ?? '');
  const [atTime, setAtTime] = useState('12:00');

  const notable = changes.filter((change) => change.kind !== 'kept');
  const isPinned = selected ? pinned.includes(selected.item.placeId) : false;

  return (
    <section className="atp-disrupt" aria-label="Something changed">
      <h3>Something changed?</h3>

      <div className="atp-disrupt__where">
        <label htmlFor="now-date">I am at</label>
        <select id="now-date" value={atDate} onChange={(event) => setAtDate(event.target.value)}>
          {itinerary.days.map((day) => (
            <option key={day.date} value={day.date}>
              {formatDayLabel(day.date)}
            </option>
          ))}
        </select>
        <input
          id="now-time"
          type="time"
          aria-label="Current time"
          value={atTime}
          onChange={(event) => setAtTime(event.target.value)}
        />
      </div>

      <div className="atp-disrupt__row">
        <span className="atp-disrupt__label">Running late by</span>
        {LATE_OPTIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="atp-chip"
            disabled={busy}
            title={`The plan picks back up ${minutes} minutes after ${atTime}. Anything before ${atTime} is left alone.`}
            onClick={() => onDisrupt({ kind: 'running-late', minutes }, { date: atDate, minute: atTime })}
          >
            {minutes}m
          </button>
        ))}
      </div>

      {selected ? (
        <div className="atp-disrupt__row">
          <span className="atp-disrupt__label">{selected.item.place.name}</span>
          <button
            type="button"
            className={`atp-chip${isPinned ? ' is-active' : ''}`}
            disabled={busy}
            aria-pressed={isPinned}
            title="Keep this exactly where it is when the plan changes"
            onClick={() =>
              onDisrupt({ kind: isPinned ? 'unpin' : 'pin', placeId: selected.item.placeId })
            }
          >
            {isPinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            className="atp-chip"
            disabled={busy}
            onClick={() => onDisrupt({ kind: 'place-closed', placeId: selected.item.placeId, date: selected.date })}
          >
            Closed today
          </button>
          <button
            type="button"
            className="atp-chip"
            disabled={busy}
            onClick={() => onDisrupt({ kind: 'drop', placeId: selected.item.placeId })}
          >
            Not interested
          </button>
          {itinerary.days.length > 1 ? (
            <select
              aria-label={`Move ${selected.item.place.name} to another day`}
              className="atp-disrupt__move"
              value=""
              disabled={busy}
              onChange={(event) => {
                if (!event.target.value) return;
                onDisrupt({ kind: 'move', placeId: selected.item.placeId, toDate: event.target.value });
              }}
            >
              <option value="">Move to…</option>
              {itinerary.days
                .filter((day) => day.date !== selected.date)
                .map((day) => (
                  <option key={day.date} value={day.date}>
                    {formatDayLabel(day.date)}
                  </option>
                ))}
            </select>
          ) : null}
        </div>
      ) : (
        <p className="atp-disrupt__hint">Pick a stop to pin it, move it, or report it closed.</p>
      )}

      {summary.length > 0 ? (
        <div className="atp-changes" role="status">
          <div className="atp-changes__head">
            {summary.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <button type="button" className="atp-changes__dismiss" onClick={onDismiss}>
              Dismiss
            </button>
          </div>

          {notable.length > 0 ? (
            <ul>
              {notable.map((change) => (
                <li key={`${change.kind}-${change.placeId}`} className={`atp-change atp-change--${change.kind}`}>
                  <span className="atp-change__kind">{change.kind}</span>
                  <span className="atp-change__name">{change.name}</span>
                  <span className="atp-change__why">{change.reason}</span>
                  {change.from && change.to ? (
                    <span className="atp-change__when">
                      {formatClock(change.from.start)} &rarr; {formatClock(change.to.start)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
