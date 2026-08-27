import type { Change, Itinerary, ScheduledItem } from '@atp/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  fetchDestination,
  fetchDestinations,
  requestPlan,
  requestReplan,
  type Destination,
  type DestinationSummary,
  type PlanFormState,
} from './api.js';
import { DayTimeline, TripSummary } from './components/DayTimeline.js';
import { DisruptionBar, type DisruptionAction } from './components/DisruptionBar.js';
import { ItineraryMap } from './components/ItineraryMap.js';
import { TripForm } from './components/TripForm.js';
import { addDaysIso, formatDayLabel, todayIso } from './format.js';

function initialForm(): PlanFormState {
  const start = addDaysIso(todayIso(), 21);
  return {
    destinationId: 'barcelona',
    startDate: start,
    endDate: addDaysIso(start, 3),
    budgetTotal: 600,
    travelers: 2,
    pace: 'balanced',
    dayStart: '09:00',
    // Late enough to contain the default 19:30 dinner window.
    dayEnd: '22:00',
    maxWalkMinutes: 22,
    preferredModes: ['walk', 'transit'],
    interests: {},
    avoidCategories: [],
    mustSeeIds: [],
    meals: ['lunch', 'dinner'],
    dietary: [],
    cuisines: [],
  };
}

export function App() {
  const [destinations, setDestinations] = useState<DestinationSummary[]>([]);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [form, setForm] = useState<PlanFormState>(initialForm);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [plannedBudget, setPlannedBudget] = useState(0);
  const [activeDay, setActiveDay] = useState<number | null>(0);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-planning state. Pins survive across rounds, so the traveller only has to
  // say "keep this" once.
  const [pinned, setPinned] = useState<string[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [replanSummary, setReplanSummary] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchDestinations()
      .then(({ destinations: list }) => {
        if (cancelled) return;
        setDestinations(list);
        if (list.length > 0 && !list.some((entry) => entry.id === form.destinationId)) {
          setForm((current) => ({ ...current, destinationId: list[0]!.id }));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeError(cause));
      });
    return () => {
      cancelled = true;
    };
    // Runs once: the destination list does not change while the app is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the chosen destination's places, and reset the budget to a sensible
  // default for it -- a Kyoto budget in yen is not a Lisbon budget in euros.
  useEffect(() => {
    if (!form.destinationId) return;
    let cancelled = false;
    fetchDestination(form.destinationId)
      .then(({ destination: loaded }) => {
        if (cancelled) return;
        setDestination(loaded);
        setForm((current) => {
          const days = Math.max(
            1,
            1 +
              Math.round(
                (Date.parse(`${current.endDate}T00:00:00Z`) - Date.parse(`${current.startDate}T00:00:00Z`)) /
                  86_400_000,
              ),
          );
          return { ...current, budgetTotal: loaded.suggestedDailyBudget * current.travelers * days };
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [form.destinationId]);

  const patchForm = useCallback((patch: Partial<PlanFormState>) => {
    setForm((current) => {
      const next = { ...current, ...patch };
      // Keep the range the right way round as the traveller edits either end.
      if (next.endDate < next.startDate) next.endDate = next.startDate;
      return next;
    });
  }, []);

  const plan = useCallback(async () => {
    setPlanning(true);
    setError(null);
    try {
      const { itinerary: result } = await requestPlan(form);
      setItinerary(result);
      setPlannedBudget(form.budgetTotal);
      setActiveDay(0);
      setSelectedPlaceId(null);
      // A fresh plan starts a fresh conversation about it.
      setPinned([]);
      setChanges([]);
      setReplanSummary([]);
    } catch (cause: unknown) {
      setError(describeError(cause));
    } finally {
      setPlanning(false);
    }
  }, [form]);

  const disrupt = useCallback(
    async (action: DisruptionAction, now?: { date: string; minute: string }) => {
      if (!itinerary) return;
      setPlanning(true);
      setError(null);
      try {
        const result = await requestReplan(form, itinerary, [action], {
          ...(now ? { now } : {}),
          pinned,
        });
        setItinerary(result.itinerary);
        setChanges(result.changes);
        setReplanSummary(result.summary);
        setPinned(result.pinned);
      } catch (cause: unknown) {
        setError(describeError(cause));
      } finally {
        setPlanning(false);
      }
    },
    [form, itinerary, pinned],
  );

  /** The selected stop, with the day it sits on: what the stop actions act upon. */
  const selectedStop = useMemo<{ item: ScheduledItem; date: string } | null>(() => {
    if (!itinerary || !selectedPlaceId) return null;
    for (const day of itinerary.days) {
      const item = day.items.find((entry) => entry.placeId === selectedPlaceId);
      if (item) return { item, date: day.date };
    }
    return null;
  }, [itinerary, selectedPlaceId]);

  // The weather strip only shows hours the traveller intends to be out in.
  const dayWindowHours = useMemo<[number, number]>(() => {
    const parse = (clock: string, fallback: number) => {
      const hour = Number.parseInt(clock.slice(0, 2), 10);
      return Number.isNaN(hour) ? fallback : hour;
    };
    const from = parse(form.dayStart, 9);
    const to = Math.max(from + 1, parse(form.dayEnd, 20));
    return [from, Math.min(23, to - 1)];
  }, [form.dayStart, form.dayEnd]);

  const dayTabs = useMemo(
    () =>
      (itinerary?.days ?? []).map((day, index) => ({
        index,
        label: formatDayLabel(day.date),
        stops: day.items.length,
      })),
    [itinerary],
  );

  return (
    <div className="atp-shell">
      <aside className="atp-sidebar">
        <header className="atp-brand">
          <h1>AI Travel Planner</h1>
          <p>
            Tell it what you like and what you can spend. It reads opening hours, the forecast and the map, then
            builds days that actually work.
          </p>
        </header>

        <TripForm
          destinations={destinations}
          destination={destination}
          form={form}
          onChange={patchForm}
          onSubmit={plan}
          planning={planning}
        />

        {error ? (
          <p className="atp-error" role="alert">
            {error}
          </p>
        ) : null}

        {itinerary ? (
          <>
            <TripSummary itinerary={itinerary} budgetTotal={plannedBudget} />
            <DisruptionBar
              itinerary={itinerary}
              selected={selectedStop}
              pinned={pinned}
              changes={changes}
              summary={replanSummary}
              busy={planning}
              onDisrupt={disrupt}
              onDismiss={() => {
                setChanges([]);
                setReplanSummary([]);
              }}
            />
            {itinerary.days.map((day, index) => (
              <DayTimeline
                key={day.date}
                day={day}
                currency={itinerary.currency}
                dayWindowHours={dayWindowHours}
                pinned={pinned}
                selectedPlaceId={selectedPlaceId}
                onSelectPlace={(placeId) => {
                  setSelectedPlaceId(placeId);
                  if (placeId) setActiveDay(index);
                }}
              />
            ))}
          </>
        ) : null}
      </aside>

      <main className="atp-main">
        {itinerary ? (
          <>
            <nav className="atp-daybar" aria-label="Days">
              <button
                type="button"
                className={activeDay === null ? 'is-active' : ''}
                aria-pressed={activeDay === null}
                onClick={() => setActiveDay(null)}
              >
                Whole trip
              </button>
              {dayTabs.map((tab) => (
                <button
                  key={tab.index}
                  type="button"
                  className={activeDay === tab.index ? 'is-active' : ''}
                  aria-pressed={activeDay === tab.index}
                  onClick={() => setActiveDay(tab.index)}
                >
                  {tab.label}
                  <span className="atp-daybar__count">{tab.stops}</span>
                </button>
              ))}
            </nav>
            <ItineraryMap
              itinerary={itinerary}
              activeDay={activeDay}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
            />
          </>
        ) : (
          <div className="atp-placeholder">
            <p>{planning ? 'Working out the best order…' : 'Set your trip up on the left, then plan it.'}</p>
          </div>
        )}
      </main>
    </div>
  );
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.issues && cause.issues.length > 0) {
      return `${cause.message}: ${cause.issues.map((issue) => `${issue.path} ${issue.message}`).join(', ')}`;
    }
    return cause.message;
  }
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong.';
}
