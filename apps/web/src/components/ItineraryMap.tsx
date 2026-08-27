import type { DayPlan, Itinerary, ScheduledItem } from '@atp/core';
import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';

import { CATEGORY_COLORS, MODE_ICONS, categoryLabel, formatClock, formatDuration, formatMoney } from '../format.js';

type Props = {
  itinerary: Itinerary;
  /** Index of the day in focus, or `null` to show the whole trip at once. */
  activeDay: number | null;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string | null) => void;
};

/**
 * A numbered pin, coloured by category.
 *
 * Built as a `divIcon` rather than an image so the stop number is real text:
 * legible at any zoom, and readable by a screen reader through the marker's
 * alt text.
 */
function pinIcon(item: ScheduledItem, order: number, selected: boolean): L.DivIcon {
  const color = CATEGORY_COLORS[item.place.category] ?? '#6b7280';
  const size = selected ? 40 : 32;
  return L.divIcon({
    className: 'atp-pin-wrapper',
    html: `<div class="atp-pin${selected ? ' atp-pin--selected' : ''}" style="--pin-color:${color};--pin-size:${size}px">
             <span>${order}</span>
           </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size + 4],
  });
}

function baseIcon(): L.DivIcon {
  return L.divIcon({
    className: 'atp-pin-wrapper',
    html: '<div class="atp-base" title="Trip base">⌂</div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/** Keeps the viewport framed on whatever is currently being shown. */
function FitBounds({ points }: { points: [number, number][] }): null {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0]!, 14, { animate: true });
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15, animate: true });
  }, [map, points]);

  return null;
}

type DayRoute = {
  day: DayPlan;
  index: number;
  points: [number, number][];
  color: string;
};

/** Distinct hues per day, so a whole-trip view stays readable. */
const DAY_COLORS = ['#4f8ef7', '#e8863d', '#3fa86a', '#c9548e', '#8b6cf0', '#3aa8bd', '#d9a13d'];

export function ItineraryMap({ itinerary, activeDay, selectedPlaceId, onSelectPlace }: Props) {
  const visibleDays = useMemo(
    () => (activeDay === null ? itinerary.days.map((day, index) => ({ day, index })) : [{ day: itinerary.days[activeDay]!, index: activeDay }]),
    [itinerary.days, activeDay],
  );

  const routes: DayRoute[] = useMemo(
    () =>
      visibleDays
        .filter(({ day }) => day.items.length > 0)
        .map(({ day, index }) => ({
          day,
          index,
          color: DAY_COLORS[index % DAY_COLORS.length]!,
          points: day.items.map((item) => [item.place.coord.lat, item.place.coord.lon] as [number, number]),
        })),
    [visibleDays],
  );

  const allPoints = useMemo(() => routes.flatMap((route) => route.points), [routes]);

  const center: [number, number] = [itinerary.destination.center.lat, itinerary.destination.center.lon];

  return (
    <MapContainer center={center} zoom={13} className="atp-map" scrollWheelZoom zoomControl>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />

      <FitBounds points={allPoints} />

      {routes.map((route) => (
        <Polyline
          key={`route-${route.day.date}`}
          positions={route.points}
          pathOptions={{ color: route.color, weight: 3, opacity: 0.75, dashArray: '1 6', lineCap: 'round' }}
        />
      ))}

      {/* The journey home, drawn faintly so it reads as a return rather than a stop. */}
      {routes.map((route) => {
        const last = route.day.items[route.day.items.length - 1];
        const base = route.day.returnToBase;
        if (!last || !base) return null;
        const anchor = anchorCoordFor(itinerary, base.toPlaceId);
        if (!anchor) return null;
        return (
          <Polyline
            key={`home-${route.day.date}`}
            positions={[[last.place.coord.lat, last.place.coord.lon], anchor]}
            pathOptions={{ color: route.color, weight: 2, opacity: 0.3, dashArray: '2 8' }}
          />
        );
      })}

      {routes.flatMap((route) =>
        route.day.items.map((item, order) => (
          <Marker
            key={`${route.day.date}-${item.placeId}`}
            position={[item.place.coord.lat, item.place.coord.lon]}
            icon={pinIcon(item, order + 1, item.placeId === selectedPlaceId)}
            alt={`Stop ${order + 1}: ${item.place.name}`}
            eventHandlers={{
              click: () => onSelectPlace(item.placeId),
              popupclose: () => onSelectPlace(null),
            }}
          >
            <Popup>
              <div className="atp-popup">
                <strong>{item.place.name}</strong>
                <div className="atp-popup__meta">
                  {categoryLabel(item.place.category)} &middot; {formatClock(item.start)}&ndash;{formatClock(item.end)}
                  {item.cost > 0 ? ` · ${formatMoney(item.cost, itinerary.currency)}` : ' · free'}
                </div>
                {item.place.description ? <p className="atp-popup__body">{item.place.description}</p> : null}
                {item.arrival && item.arrival.minutes > 0 ? (
                  <div className="atp-popup__leg">
                    {MODE_ICONS[item.arrival.mode]} {formatDuration(item.arrival.minutes)} to get here
                  </div>
                ) : null}
                {item.reasons.length > 0 ? (
                  <ul className="atp-popup__reasons">
                    {item.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Popup>
          </Marker>
        )),
      )}

      {anchorMarker(itinerary)}
    </MapContainer>
  );
}

/** Where the day's return leg points to, resolved to coordinates. */
function anchorCoordFor(itinerary: Itinerary, anchorId: string): [number, number] | null {
  if (anchorId === '__origin__') {
    return [itinerary.destination.center.lat, itinerary.destination.center.lon];
  }
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.placeId === anchorId) return [item.place.coord.lat, item.place.coord.lon];
    }
  }
  // Lodging is not itself a scheduled stop, so fall back to the city centre.
  return [itinerary.destination.center.lat, itinerary.destination.center.lon];
}

function anchorMarker(itinerary: Itinerary) {
  const anchorId = itinerary.days.find((day) => day.returnToBase)?.returnToBase?.toPlaceId;
  if (!anchorId) return null;
  const coord = anchorCoordFor(itinerary, anchorId);
  if (!coord) return null;
  return (
    <Marker position={coord} icon={baseIcon()} alt="Trip base">
      <Popup>
        <div className="atp-popup">
          <strong>Trip base</strong>
          <div className="atp-popup__meta">Every day starts and ends here.</div>
        </div>
      </Popup>
    </Marker>
  );
}
