/**
 * Generates the diagrams in `docs/` from real planner output.
 *
 * Run with `npm run diagrams`. Nothing here is drawn by hand: every bar, label
 * and coordinate comes from an actual `planTrip` call, so the pictures in the
 * README cannot quietly stop matching the engine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatClock,
  formatDuration,
  openWindowsOn,
  planTrip,
  replan,
  type Change,
  type DailyWeather,
  type Itinerary,
  type Place,
  type PlanRequest,
} from '@atp/core';

import { BARCELONA_PLACES } from '../src/data/barcelona.js';
import { DESTINATIONS } from '../src/data/destinations.js';
import { SyntheticWeatherProvider } from '../src/providers/weather.js';
import { circle, legend, line, rampLegend, rect, round, svgDocument, text, textWidth } from './svg.js';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs');

const BARCELONA = DESTINATIONS.find((entry) => entry.id === 'barcelona')!;

const PREFERENCES = {
  interests: {
    architecture: 1,
    'art-nouveau': 0.9,
    views: 0.7,
    food: 0.6,
    art: 0.5,
    beaches: -0.3,
  },
  pace: 'balanced' as const,
  travelers: 2,
  dayStart: 9 * 60,
  dayEnd: 22 * 60,
  meals: ['lunch' as const, 'dinner' as const],
  cuisines: ['catalan', 'tapas'],
  mustSeeIds: [] as string[],
  avoidCategories: [] as never[],
  dietary: [] as never[],
  maxWalkMinutes: 22,
  preferredModes: ['walk' as const, 'transit' as const],
};

async function barcelonaTrip(): Promise<{ request: PlanRequest; itinerary: Itinerary }> {
  const dates = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14'];
  const weather = await new SyntheticWeatherProvider().forecast(BARCELONA.center, dates);

  const request: PlanRequest = {
    destination: { name: BARCELONA.name, center: BARCELONA.center, timezone: BARCELONA.timezone },
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
    budget: { total: 900, currency: 'EUR' },
    preferences: PREFERENCES as PlanRequest['preferences'],
    candidates: BARCELONA_PLACES,
    weather,
  };
  return { request, itinerary: planTrip(request) };
}

// ---------------------------------------------------------------------------
// 1. A real day, as the scheduler sees it: opening hours, visits, travel, meals
// ---------------------------------------------------------------------------

function renderDaySchedule(itinerary: Itinerary): string {
  const day = itinerary.days.reduce((best, entry) => (entry.items.length > best.items.length ? entry : best));

  const fromHour = 9;
  const toHour = 22;
  const gutter = 214;
  const rightPad = 24;
  const width = 900;
  const plotLeft = gutter;
  const plotRight = width - rightPad;
  const plotWidth = plotRight - plotLeft;
  const rowHeight = 34;
  const headerHeight = 74;
  const footerHeight = 46;
  const height = headerHeight + day.items.length * rowHeight + footerHeight;

  const xOf = (minute: number): number =>
    plotLeft + ((minute - fromHour * 60) / ((toHour - fromHour) * 60)) * plotWidth;

  const body: string[] = [];

  body.push(text(24, 30, `A single day, as the scheduler sees it`, { size: 16, weight: 650 }));
  body.push(
    text(24, 50, `${day.date} in ${itinerary.destination.name} · ${formatDuration(day.totals.travelMinutes)} of travel · ${itinerary.currency} ${day.totals.cost}`, {
      size: 11.5,
      className: 't-dim',
    }),
  );

  // Hourly grid: solid hairlines, one shade off the surface.
  for (let hour = fromHour; hour <= toHour; hour += 1) {
    const x = xOf(hour * 60);
    body.push(line(x, headerHeight - 12, x, height - footerHeight + 4));
    // Always label the ends of the day, then every other hour between them.
    if (hour === fromHour || hour === toHour || hour % 2 === 0) {
      body.push(text(x, height - footerHeight + 20, formatClock(hour * 60), { size: 10, anchor: 'middle', className: 't-faint' }));
    }
  }

  day.items.forEach((item, index) => {
    const y = headerHeight + index * rowHeight;
    const isMeal = item.kind === 'meal';
    const barColor = isMeal ? 'var(--s2)' : 'var(--s1)';

    // The place's opening hours today, as a recessive band behind the visit.
    for (const slot of openWindowsOn(item.place.openingHours, day.date)) {
      const start = Math.max(slot.start, fromHour * 60);
      const end = Math.min(slot.end, toHour * 60);
      if (end <= start) continue;
      body.push(rect(xOf(start), y + 6, xOf(end) - xOf(start), 18, 'var(--band)', 3));
    }

    // The journey that got the traveller here.
    if (item.arrival && item.arrival.minutes > 0) {
      const arriveEnd = xOf(item.start);
      const arriveStart = Math.max(plotLeft, xOf(item.start - item.arrival.minutes));
      body.push(
        line(arriveStart, y + 15, arriveEnd, y + 15, 'stroke="var(--ink-3)" stroke-width="1.5" opacity="0.55"'),
      );
      body.push(circle(arriveStart, y + 15, 2, 'var(--ink-3)'));
    }

    // The visit itself: a thin mark with rounded ends.
    body.push(rect(xOf(item.start), y + 7, xOf(item.end) - xOf(item.start), 16, barColor, 4));

    const label = isMeal ? `${item.place.name}` : item.place.name;
    body.push(
      text(gutter - 12, y + 19, truncate(label, 31), { size: 11.5, anchor: 'end', weight: isMeal ? 500 : 400 }),
    );
    body.push(
      text(xOf(item.end) + 8, y + 19, `${formatClock(item.start)}–${formatClock(item.end)}`, {
        size: 10,
        className: 't-faint',
      }),
    );
  });

  body.push(
    legend(24, height - 14, [
      { color: 'var(--band)', label: 'open today' },
      { color: 'var(--s1)', label: 'visit' },
      { color: 'var(--s2)', label: 'meal' },
      { color: 'var(--ink-3)', label: 'travel' },
    ]),
  );

  return svgDocument(
    width,
    height,
    'One planned day, showing opening hours, travel and visits',
    day.items
      .map(
        (item) =>
          `${formatClock(item.start)} to ${formatClock(item.end)}, ${item.place.name}${item.kind === 'meal' ? ' (meal)' : ''}`,
      )
      .join('. '),
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 2. The same two candidates, reordered by the forecast
// ---------------------------------------------------------------------------

function hourlyRain(wetHours: readonly number[]): DailyWeather['hourly'] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    tempC: 19,
    precipitationChance: wetHours.includes(hour) ? 0.85 : 0.05,
    precipitationMm: wetHours.includes(hour) ? 3 : 0,
  }));
}

function weatherFor(date: string, wetHours: readonly number[]): DailyWeather {
  return {
    date,
    condition: wetHours.length > 0 ? 'rain' : 'clear',
    tempMinC: 15,
    tempMaxC: 23,
    precipitationChance: wetHours.length > 0 ? 0.85 : 0.05,
    precipitationMm: wetHours.length > 0 ? 6 : 0,
    windKph: 10,
    hourly: hourlyRain(wetHours),
  };
}

function pick(id: string): Place {
  const place = BARCELONA_PLACES.find((entry) => entry.id === id);
  if (!place) throw new Error(`no such place: ${id}`);
  return place;
}

function planUnder(wetHours: readonly number[]): Itinerary {
  const date = '2026-05-13';
  return planTrip({
    destination: { name: BARCELONA.name, center: BARCELONA.center },
    startDate: date,
    endDate: date,
    budget: { total: 300, currency: 'EUR' },
    preferences: {
      ...PREFERENCES,
      interests: { parks: 0.8, art: 0.8 },
      meals: [],
      dayStart: 9 * 60,
      dayEnd: 19 * 60,
    } as PlanRequest['preferences'],
    // A park and a gallery, equally wanted. Only the forecast separates them.
    candidates: [pick('bcn-ciutadella'), pick('bcn-picasso-museum')],
    weather: [weatherFor(date, wetHours)],
  });
}

function renderWeatherReorder(): string {
  const scenarios = [
    { label: 'Dry morning, wet afternoon', wet: [13, 14, 15, 16, 17, 18] },
    { label: 'Wet morning, dry afternoon', wet: [9, 10, 11] },
  ].map((scenario) => ({ ...scenario, itinerary: planUnder(scenario.wet) }));

  const fromHour = 9;
  const toHour = 19;
  const width = 900;
  const plotLeft = 40;
  const plotRight = width - 150;
  const plotWidth = plotRight - plotLeft;
  const panelHeight = 118;
  const headerHeight = 78;
  const height = headerHeight + scenarios.length * panelHeight + 40;

  const xOf = (minute: number): number =>
    plotLeft + ((minute - fromHour * 60) / ((toHour - fromHour) * 60)) * plotWidth;

  const body: string[] = [];
  body.push(text(24, 30, 'The forecast reorders the day', { size: 16, weight: 650 }));
  body.push(
    text(24, 50, 'Same park, same gallery, same appetite for both. Only the hours the rain falls in change.', {
      size: 11.5,
      className: 't-dim',
    }),
  );

  scenarios.forEach((scenario, index) => {
    const top = headerHeight + index * panelHeight;
    const day = scenario.itinerary.days[0]!;

    body.push(text(24, top + 4, scenario.label, { size: 12, weight: 600 }));

    // Rain by the hour: one hue, light to dark, with a scale legend below.
    const barTop = top + 16;
    for (let hour = fromHour; hour < toHour; hour += 1) {
      const risk = day.weather?.hourly?.find((entry) => entry.hour === hour)?.precipitationChance ?? 0;
      const step = risk >= 0.7 ? 'var(--ramp-4)' : risk >= 0.45 ? 'var(--ramp-3)' : risk >= 0.2 ? 'var(--ramp-2)' : 'var(--ramp-1)';
      const x = xOf(hour * 60);
      // A 2px surface gap between fills rather than a border.
      body.push(rect(x + 1, barTop, xOf((hour + 1) * 60) - x - 2, 12, step, 2));
    }
    body.push(text(plotRight + 10, barTop + 10, 'rain by the hour', { size: 10, className: 't-faint' }));

    // The resulting order.
    const rowTop = barTop + 26;
    day.items.forEach((item, position) => {
      const y = rowTop + position * 26;
      // Blue is reserved for rain in this figure, so the two stop types take the
      // warm and green slots. Using slot 1 here would put the same blue on
      // "indoors" and on "likely rain" in the same legend.
      const color = item.place.indoor ? 'var(--s2)' : 'var(--s3)';
      body.push(rect(xOf(item.start), y, xOf(item.end) - xOf(item.start), 16, color, 4));
      body.push(
        text(xOf(item.end) + 8, y + 12, `${truncate(item.place.name, 26)} · ${formatClock(item.start)}`, {
          size: 10.5,
          className: 't-dim',
        }),
      );
    });

    for (let hour = fromHour; hour <= toHour; hour += 2) {
      body.push(text(xOf(hour * 60), top + 108, formatClock(hour * 60), { size: 9.5, anchor: 'middle', className: 't-faint' }));
    }
  });

  body.push(
    legend(24, height - 14, [
      { color: 'var(--s2)', label: 'indoors' },
      { color: 'var(--s3)', label: 'outdoors' },
    ]),
  );
  body.push(
    rampLegend(
      260,
      height - 14,
      ['var(--ramp-1)', 'var(--ramp-2)', 'var(--ramp-3)', 'var(--ramp-4)'],
      'dry',
      'rain likely',
    ),
  );

  return svgDocument(
    width,
    height,
    'The same two candidates, reordered by the forecast',
    scenarios
      .map(
        (scenario) =>
          `${scenario.label}: ${scenario.itinerary.days[0]!.items.map((item) => item.place.name).join(', then ')}`,
      )
      .join('. '),
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 3. Where the money went
// ---------------------------------------------------------------------------

function renderBudget(itinerary: Itinerary, budgetTotal: number): string {
  const travelers = PREFERENCES.travelers;
  const food = itinerary.totals.mealCost;
  const transport = itinerary.days.reduce(
    (sum, day) =>
      sum +
      day.items.reduce((legs, item) => legs + (item.arrival?.cost ?? 0), 0) +
      (day.returnToBase?.cost ?? 0),
    0,
  );
  const tickets = round(itinerary.totals.cost - food - transport);
  const unspent = round(budgetTotal - itinerary.totals.cost);

  const segments = [
    { label: 'Tickets', value: tickets, color: 'var(--s1)' },
    { label: 'Food', value: food, color: 'var(--s2)' },
    { label: 'Transport', value: round(transport), color: 'var(--s3)' },
    { label: 'Unspent', value: Math.max(0, unspent), color: 'var(--band)' },
  ].filter((segment) => segment.value > 0);

  const width = 900;
  const height = 190;
  const barLeft = 24;
  const barRight = width - 24;
  const barWidth = barRight - barLeft;
  const barTop = 96;
  const barHeight = 34;

  const body: string[] = [];
  body.push(text(24, 30, 'Where the money went', { size: 16, weight: 650 }));
  body.push(
    text(
      24,
      50,
      `${itinerary.days.length} days in ${itinerary.destination.name} for ${travelers} · ${itinerary.currency} ${itinerary.totals.cost} of a ${itinerary.currency} ${budgetTotal} budget · ${itinerary.totals.placesVisited} stops and ${itinerary.totals.mealsBooked} meals`,
      { size: 11.5, className: 't-dim' },
    ),
  );
  body.push(
    text(24, 74, 'The budget is a ceiling, not a target: the trip total is checked on every insertion, fares and the journey home included.', {
      size: 11,
      className: 't-faint',
    }),
  );

  let cursor = barLeft;
  for (const segment of segments) {
    const segmentWidth = (segment.value / budgetTotal) * barWidth;
    // A 2px surface gap between segments rather than a stroke.
    body.push(rect(cursor, barTop, segmentWidth - 2, barHeight, segment.color, 4));

    // Direct-label only the segments wide enough to hold a label without
    // running into their neighbour. The rest are carried by the legend, which
    // always lists every segment with its value.
    const inline = `${itinerary.currency} ${segment.value}`;
    if (segmentWidth > textWidth(inline, 11) + 20) {
      body.push(
        text(cursor + segmentWidth / 2, barTop + barHeight / 2 + 4, inline, {
          size: 11,
          weight: 600,
          anchor: 'middle',
          fill: segment.color === 'var(--band)' ? 'var(--ink-2)' : 'var(--surface)',
        }),
      );
    }
    cursor += segmentWidth;
  }

  body.push(
    legend(
      barLeft,
      barTop + barHeight + 30,
      segments.map((segment) => ({
        color: segment.color,
        label: `${segment.label} · ${itinerary.currency} ${segment.value}`,
      })),
    ),
  );

  body.push(line(barLeft, barTop - 8, barRight, barTop - 8));
  body.push(text(barRight, barTop - 14, `ceiling ${itinerary.currency} ${budgetTotal}`, { size: 10, anchor: 'end', className: 't-faint' }));

  return svgDocument(
    width,
    height,
    'Budget breakdown for a planned trip',
    segments.map((segment) => `${segment.label}: ${itinerary.currency} ${segment.value}`).join('. '),
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 4. The route on the ground
// ---------------------------------------------------------------------------

function renderDayMap(itinerary: Itinerary): string {
  const day = itinerary.days.reduce((best, entry) => (entry.items.length > best.items.length ? entry : best));
  const base = itinerary.destination.center;
  const all = [...day.items.map((item) => item.place.coord), base];

  const listWidth = 300;
  const pad = 40;

  const lats = all.map((coord) => coord.lat);
  const lons = all.map((coord) => coord.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // Latitude and longitude are not interchangeable: one degree of longitude is
  // shorter than one of latitude away from the equator, so the aspect has to be
  // corrected or the city comes out stretched sideways.
  const lonScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max(1e-6, (maxLon - minLon) * lonScale);
  const spanY = Math.max(1e-6, maxLat - minLat);

  // Size the canvas to the shape of the data, rather than cropping the data into
  // a fixed canvas. A day whose stops run north to south genuinely plots tall and
  // narrow; forcing it into a wide frame either distorts the geography or leaves
  // two thirds of the picture empty.
  const plotHeight = 400;
  const headerHeight = 76;
  const height = headerHeight + plotHeight + 44;
  const maxPlotWidth = 520;
  const scale = Math.min(plotHeight / spanY, maxPlotWidth / spanX);
  const drawnWidth = spanX * scale;

  const width = Math.max(620, listWidth + drawnWidth + pad * 2);
  const plotLeft = listWidth + pad;
  const plotWidth = drawnWidth;

  const plotCentreX = plotLeft + plotWidth / 2;
  const plotCentreY = headerHeight + plotHeight / 2;
  const project = (coord: { lat: number; lon: number }): [number, number] => [
    plotCentreX + (coord.lon - (minLon + maxLon) / 2) * lonScale * scale,
    // Screen y grows downwards; latitude grows upwards.
    plotCentreY - (coord.lat - (minLat + maxLat) / 2) * scale,
  ];

  const body: string[] = [];
  body.push(text(24, 30, 'The same day on the ground', { size: 16, weight: 650 }));
  body.push(
    text(
      24,
      50,
      `${day.date} · ${formatDuration(day.totals.travelMinutes)} of travel, ${(day.totals.distanceMeters / 1000).toFixed(1)} km covered`,
      { size: 11.5, className: 't-dim' },
    ),
  );

  const projected = day.items.map((item) => project(item.place.coord));
  const basePoint = project(base);

  if (projected.length > 1) {
    const d = projected.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`).join(' ');
    body.push(
      `  <path d="${d}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" opacity="0.7"/>`,
    );
  }

  // The journey home, drawn faintly so it reads as a return rather than a leg.
  const last = projected[projected.length - 1];
  if (last) {
    body.push(
      `  <path d="M${round(last[0])},${round(last[1])} L${round(basePoint[0])},${round(basePoint[1])}" fill="none" stroke="var(--s1)" stroke-width="1.5" opacity="0.3"/>`,
    );
  }

  body.push(circle(basePoint[0], basePoint[1], 7, 'var(--surface)'));
  body.push(circle(basePoint[0], basePoint[1], 5, 'var(--ink-3)'));

  // Names live in the list, not on the plot. Plotting a dozen labels over a
  // dozen pins guarantees collisions; numbering the pins and naming them once,
  // beside the map, does not.
  let ordinal = 0;
  const rows: string[] = [];
  const rowTop = headerHeight + 4;
  const rowHeight = Math.min(26, (plotHeight - 20) / Math.max(1, day.items.length));

  day.items.forEach((item, index) => {
    const [x, y] = projected[index]!;
    const isMeal = item.kind === 'meal';
    if (!isMeal) ordinal += 1;
    const marker = isMeal ? '' : String(ordinal);
    const colour = isMeal ? 'var(--s2)' : 'var(--s1)';

    // A 2px surface ring on overlapping marks, rather than a border.
    body.push(circle(x, y, isMeal ? 8 : 11, 'var(--surface)'));
    body.push(circle(x, y, isMeal ? 6 : 9, colour));
    if (marker) {
      body.push(
        text(x, y + 3.4, marker, { size: 10.5, weight: 700, anchor: 'middle', fill: 'var(--surface)' }),
      );
    }

    const rowY = rowTop + index * rowHeight;
    rows.push(circle(30, rowY - 3.5, isMeal ? 5 : 7.5, colour));
    if (marker) {
      rows.push(text(30, rowY, marker, { size: 9, weight: 700, anchor: 'middle', fill: 'var(--surface)' }));
    }
    rows.push(
      text(46, rowY, truncate(item.place.name, 34), { size: 11, weight: isMeal ? 500 : 400 }),
    );
    rows.push(
      text(listWidth - 30, rowY, formatClock(item.start), { size: 10, anchor: 'end', className: 't-faint' }),
    );
  });

  rows.push(circle(30, rowTop + day.items.length * rowHeight - 3.5, 5, 'var(--ink-3)'));
  rows.push(
    text(46, rowTop + day.items.length * rowHeight, 'back to base', { size: 11, className: 't-dim' }),
  );

  // The day's figures, under the list. The space is there and the numbers are
  // the point of the picture.
  const statsTop = rowTop + (day.items.length + 2) * rowHeight;
  const stats: [string, string][] = [
    ['Spend', `${itinerary.currency} ${day.totals.cost}`],
    ['On food', `${itinerary.currency} ${day.totals.mealCost}`],
    ['On the move', formatDuration(day.totals.travelMinutes)],
    ['At places', formatDuration(day.totals.activeMinutes)],
  ];
  stats.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 26 + column * 138;
    const y = statsTop + row * 42;
    rows.push(text(x, y, value, { size: 15, weight: 650, className: 't-num' }));
    rows.push(text(x, y + 15, label, { size: 10, className: 't-faint' }));
  });

  body.push(rows.join('\n'));

  // A scale bar, so the shape of the route carries a real sense of distance.
  // `scale` is pixels per degree of latitude, and one degree of latitude is
  // about 111.32 km.
  const kmPerPixel = 111.32 / scale;
  const barKm = niceScaleLength(kmPerPixel * 90);
  const barPixels = barKm / kmPerPixel;
  // Inside the plot rather than under it, so it cannot collide with the legend.
  const barY = headerHeight + plotHeight - 16;
  body.push(line(plotCentreX - barPixels / 2, barY, plotCentreX + barPixels / 2, barY, 'stroke="var(--ink-3)" stroke-width="1.5"'));
  body.push(line(plotCentreX - barPixels / 2, barY - 3, plotCentreX - barPixels / 2, barY + 3, 'stroke="var(--ink-3)" stroke-width="1.5"'));
  body.push(line(plotCentreX + barPixels / 2, barY - 3, plotCentreX + barPixels / 2, barY + 3, 'stroke="var(--ink-3)" stroke-width="1.5"'));
  body.push(text(plotCentreX, barY + 16, `${barKm} km`, { size: 10, anchor: 'middle', className: 't-faint' }));

  body.push(
    legend(24, height - 16, [
      { color: 'var(--s1)', label: 'sightseeing stop, in order' },
      { color: 'var(--s2)', label: 'meal' },
      { color: 'var(--ink-3)', label: 'base' },
    ]),
  );

  return svgDocument(
    width,
    height,
    'The planned route for one day, plotted from real coordinates',
    day.items.map((item) => item.place.name).join(' then '),
    body.join('\n'),
  );
}

/** Rounds a scale-bar length to something a reader would actually say out loud. */
function niceScaleLength(km: number): number {
  const candidates = [0.2, 0.5, 1, 2, 5, 10, 20, 50];
  return candidates.find((candidate) => candidate >= km) ?? candidates[candidates.length - 1]!;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// 5. How a plan gets built
// ---------------------------------------------------------------------------

/**
 * The one diagram here that is drawn rather than measured: it describes the
 * shape of the code, not the shape of any particular trip.
 */
function renderPipeline(): string {
  const width = 900;
  const height = 340;
  const body: string[] = [];

  body.push(text(24, 30, 'How a plan gets built', { size: 16, weight: 650 }));
  body.push(
    text(
      24,
      50,
      'Five passes over the same day objects. Every pass re-times each day from scratch rather than patching it.',
      { size: 11.5, className: 't-dim' },
    ),
  );

  // The constraints, as inputs along the top.
  const inputs = ['budget', 'weather', 'opening hours', 'travel time', 'restaurants', 'preferences'];
  let cursor = 24;
  for (const input of inputs) {
    const chipWidth = textWidth(input, 11) + 22;
    body.push(rect(cursor, 70, chipWidth, 24, 'var(--band)', 12));
    body.push(text(cursor + chipWidth / 2, 86, input, { size: 11, anchor: 'middle', className: 't-dim' }));
    cursor += chipWidth + 8;
  }

  const passes = [
    { title: '1 · Must-sees', detail: 'placed first, before\nthe pool competes\nfor the slots' },
    { title: '2 · Insertion', detail: 'every candidate, every\nposition, every day —\nbest gain wins' },
    { title: '3 · Meals', detail: 'into their windows,\nonce a route exists\nto sit them on' },
    { title: '4 · Re-fill', detail: 'booking meals opens\nslots pass 2 never\nsaw' },
    { title: '5 · Rearrange', detail: 'relocate, reverse,\nchange day, or wait\nout a shower' },
  ];

  const boxTop = 126;
  const boxHeight = 112;
  const gap = 14;
  const boxWidth = (width - 48 - gap * (passes.length - 1)) / passes.length;

  passes.forEach((pass, index) => {
    const x = 24 + index * (boxWidth + gap);
    body.push(rect(x, boxTop, boxWidth, boxHeight, 'var(--band)', 8));
    body.push(rect(x, boxTop, 3, boxHeight, index === 1 || index === 4 ? 'var(--s1)' : 'var(--s3)', 2));
    body.push(text(x + 14, boxTop + 24, pass.title, { size: 12, weight: 650 }));
    pass.detail.split('\n').forEach((detailLine, lineIndex) => {
      body.push(text(x + 14, boxTop + 46 + lineIndex * 15, detailLine, { size: 10, className: 't-dim' }));
    });

    if (index < passes.length - 1) {
      const arrowX = x + boxWidth + gap / 2;
      const midY = boxTop + boxHeight / 2;
      body.push(
        `  <path d="M${round(arrowX - 5)},${midY} L${round(arrowX + 4)},${midY} M${round(arrowX)},${midY - 4} L${round(arrowX + 4)},${midY} L${round(arrowX)},${midY + 4}" fill="none" stroke="var(--ink-3)" stroke-width="1.5"/>`,
      );
    }
  });

  // Inputs feed every pass, so one bracket rather than a web of arrows.
  body.push(line(24, 106, width - 24, 106, 'stroke="var(--grid)" stroke-width="1"'));
  body.push(line(width / 2, 106, width / 2, boxTop - 6, 'stroke="var(--ink-3)" stroke-width="1" opacity="0.5"'));

  const outTop = boxTop + boxHeight + 26;
  body.push(rect(24, outTop, width - 48, 42, 'var(--s1)', 8));
  body.push(
    text(40, outTop + 26, 'An itinerary: timed stops, travel legs, costs, and a reason for every decision', {
      size: 12,
      weight: 600,
      fill: 'var(--surface)',
    }),
  );

  return svgDocument(
    width,
    height,
    'The four planning passes',
    'Constraints feed four passes: must-sees, repeated best-insertion, meals, then rehoming anything a meal displaced. The output is a timed itinerary with reasons.',
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 6. A disruption being absorbed
// ---------------------------------------------------------------------------

/**
 * The same day before and after the traveller loses two hours.
 *
 * Produced by an actual `replan` call, change list included, so the figure and
 * the engine cannot disagree about what happened.
 */
function renderReplan(request: PlanRequest, itinerary: Itinerary): string {
  const dayIndex = itinerary.days.reduce(
    (best, day, index) => (day.items.length > itinerary.days[best]!.items.length ? index : best),
    0,
  );
  const date = itinerary.days[dayIndex]!.date;
  const lostMinutes = 120;
  const atMinute = 11 * 60;

  const result = replan({
    itinerary,
    base: request,
    now: { date, minute: atMinute },
    disruptions: [{ kind: 'running-late', minutes: lostMinutes }],
  });

  const before = itinerary.days[dayIndex]!;
  const after = result.itinerary.days[dayIndex]!;

  const fromHour = 9;
  const toHour = 22;
  const width = 900;
  const gutter = 214;
  const plotLeft = gutter;
  const plotRight = width - 24;
  const plotWidth = plotRight - plotLeft;
  const rowHeight = 26;
  const headerHeight = 78;

  const notable = result.changes.filter((change) => change.kind !== 'kept');
  const panelHeight = (rows: number): number => 30 + rows * rowHeight;
  const changesHeight = notable.length > 0 ? 26 + notable.length * 17 : 0;
  const height =
    headerHeight + panelHeight(before.items.length) + panelHeight(after.items.length) + changesHeight + 46;

  const xOf = (minute: number): number =>
    plotLeft + ((minute - fromHour * 60) / ((toHour - fromHour) * 60)) * plotWidth;

  const body: string[] = [];
  body.push(text(24, 30, 'Absorbing two lost hours', { size: 16, weight: 650 }));
  body.push(
    text(
      24,
      50,
      `${date}: at ${formatClock(atMinute)} the traveller is ${formatDuration(lostMinutes)} behind. What had already happened is left alone.`,
      { size: 11.5, className: 't-dim' },
    ),
  );

  const drawPanel = (
    label: string,
    items: typeof before.items,
    top: number,
    highlightFrom: number | null,
  ): void => {
    body.push(text(24, top + 14, label, { size: 12, weight: 600 }));

    for (let hour = fromHour; hour <= toHour; hour += 1) {
      const x = xOf(hour * 60);
      body.push(line(x, top + 22, x, top + 22 + items.length * rowHeight));
    }

    if (highlightFrom !== null) {
      // The moment the plan resumes, marked once rather than annotated per row.
      const x = xOf(highlightFrom);
      body.push(line(x, top + 18, x, top + 26 + items.length * rowHeight, 'stroke="var(--s2)" stroke-width="1.5"'));
      body.push(text(x + 5, top + 16, `back on the road ${formatClock(highlightFrom)}`, { size: 9.5, fill: 'var(--s2)' }));
    }

    items.forEach((item, index) => {
      const y = top + 26 + index * rowHeight;
      const past = item.start < atMinute;
      const colour = item.kind === 'meal' ? 'var(--s2)' : past ? 'var(--ink-3)' : 'var(--s1)';
      body.push(rect(xOf(item.start), y, xOf(item.end) - xOf(item.start), 14, colour, 4));
      body.push(
        text(gutter - 12, y + 11, truncate(item.place.name, 31), { size: 10.5, anchor: 'end', className: past ? 't-faint' : undefined }),
      );
    });
  };

  const beforeTop = headerHeight;
  drawPanel('Planned', before.items, beforeTop, null);

  const afterTop = beforeTop + panelHeight(before.items.length);
  drawPanel('Re-planned', after.items, afterTop, atMinute + lostMinutes);

  if (notable.length > 0) {
    const listTop = afterTop + panelHeight(after.items.length) + 12;
    body.push(text(24, listTop, 'What the agent changed, and why', { size: 11, weight: 600, className: 't-dim' }));
    notable.forEach((change, index) => {
      const y = listTop + 18 + index * 17;
      body.push(text(24, y, change.kind.toUpperCase(), { size: 9, weight: 700, fill: kindColour(change) }));
      body.push(text(92, y, truncate(change.name, 34), { size: 10.5, weight: 600 }));
      body.push(text(320, y, truncate(change.reason, 78), { size: 10.5, className: 't-dim' }));
    });
  }

  body.push(
    legend(24, height - 14, [
      { color: 'var(--ink-3)', label: 'already happened' },
      { color: 'var(--s1)', label: 'still to come' },
      { color: 'var(--s2)', label: 'meal' },
    ]),
  );

  return svgDocument(
    width,
    height,
    'The same day before and after two hours are lost',
    result.summary.join(' '),
    body.join('\n'),
  );
}

function kindColour(change: Change): string {
  if (change.kind === 'dropped') return 'var(--s2)';
  if (change.kind === 'added') return 'var(--s3)';
  return 'var(--s1)';
}

// ---------------------------------------------------------------------------

const { request: tripRequest, itinerary } = await barcelonaTrip();

mkdirSync(OUT_DIR, { recursive: true });

const outputs: [string, string][] = [
  ['planning-pipeline.svg', renderPipeline()],
  ['day-schedule.svg', renderDaySchedule(itinerary)],
  ['weather-reorder.svg', renderWeatherReorder()],
  ['budget.svg', renderBudget(itinerary, 900)],
  ['day-map.svg', renderDayMap(itinerary)],
  ['replan.svg', renderReplan(tripRequest, itinerary)],
];

for (const [name, contents] of outputs) {
  writeFileSync(resolve(OUT_DIR, name), contents, 'utf8');
  console.log(`wrote docs/${name} (${(contents.length / 1024).toFixed(1)} kB)`);
}

// A short factual summary, so the README prose can be checked against the data.
console.log(
  `\nplan: ${itinerary.totals.placesVisited} stops, ${itinerary.totals.mealsBooked} meals, ` +
    `${itinerary.currency} ${itinerary.totals.cost} of 900, ${formatDuration(itinerary.totals.travelMinutes)} travelling`,
);
