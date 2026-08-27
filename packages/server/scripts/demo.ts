/**
 * Prints a planned trip to the terminal.
 *
 * A quick way to see what the engine actually produces without opening a
 * browser: `npm run demo --workspace @atp/server`.
 */
import { formatClock, formatDuration, type Itinerary } from '@atp/core';

import { createApp } from '../src/app.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Deterministic by default, so the printed trip is reproducible and the script
// works offline. Set WEATHER_PROVIDER=open-meteo to run it against a live forecast.
process.env.WEATHER_PROVIDER ??= 'synthetic';

const app = createApp();
const server = app.listen(0);
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port assigned');

const body = {
  destinationId: process.env.DESTINATION ?? 'barcelona',
  startDate: '2026-05-11',
  endDate: '2026-05-14',
  budgetTotal: Number(process.env.BUDGET ?? 900),
  preferences: {
    interests: {
      architecture: 1,
      'art-nouveau': 0.9,
      views: 0.7,
      food: 0.6,
      art: 0.5,
      beaches: -0.3,
    },
    pace: 'balanced',
    travelers: 2,
    dayStart: '09:00',
    dayEnd: '22:00',
    meals: ['lunch', 'dinner'],
    cuisines: (process.env.CUISINES ?? 'catalan,tapas').split(',').filter(Boolean),
    dietary: (process.env.DIETARY ?? '').split(',').filter(Boolean),
  },
};

const response = await fetch(`http://127.0.0.1:${address.port}/api/plan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

if (!response.ok) {
  console.error(`plan failed: ${response.status}`, await response.text());
  server.close();
  process.exit(1);
}

const { itinerary } = (await response.json()) as { itinerary: Itinerary };
const money = (amount: number): string => `${itinerary.currency} ${amount}`;

console.log(`\n=== ${itinerary.destination.name}  ${itinerary.startDate} to ${itinerary.endDate} ===`);

for (const day of itinerary.days) {
  const weather = day.weather;
  console.log(
    `\n${day.date} (${WEEKDAYS[day.weekday]})  ` +
      (weather
        ? `${weather.condition} ${weather.tempMinC}-${weather.tempMaxC}C, rain ${Math.round(weather.precipitationChance * 100)}%`
        : ''),
  );

  for (const item of day.items) {
    const leg = item.arrival;
    const label = item.kind === 'meal' ? `[${item.mealKind}] ${item.place.name}` : item.place.name;
    console.log(
      `  ${formatClock(item.start)}-${formatClock(item.end)}  ${label.padEnd(42)}` +
        `${String(item.cost).padStart(6)}  [${leg?.mode ?? '-'} ${formatDuration(leg?.minutes ?? 0)}]`,
    );
    if (item.reasons.length > 0) console.log(`               why: ${item.reasons.join('; ')}`);
    if (item.cautions.length > 0) console.log(`               note: ${item.cautions.join('; ')}`);
  }

  console.log(
    `  -- ${money(day.totals.cost)} (food ${money(day.totals.mealCost)}), ` +
      `travel ${formatDuration(day.totals.travelMinutes)}, at places ${formatDuration(day.totals.activeMinutes)}`,
  );
  for (const note of day.notes) console.log(`  * ${note}`);
}

const { totals } = itinerary;
console.log(
  `\nTOTAL  ${money(totals.cost)} of ${money(body.budgetTotal)} (left ${money(totals.budgetRemaining)})` +
    `  |  food ${money(totals.mealCost)}  |  ${totals.placesVisited} stops, ${totals.mealsBooked} meals` +
    `  |  travel ${formatDuration(totals.travelMinutes)}  |  score ${itinerary.score}`,
);

if (itinerary.rejected.length > 0) {
  console.log(`\nleft out (${itinerary.rejected.length}):`);
  for (const rejection of itinerary.rejected) {
    console.log(`  ${rejection.name.padEnd(42)} ${rejection.reason}: ${rejection.detail ?? ''}`);
  }
}

server.close();
