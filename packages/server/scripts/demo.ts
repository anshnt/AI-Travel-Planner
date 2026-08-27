import { formatClock, formatDuration, type Itinerary } from '@atp/core';
import { createApp } from './app.js';

const app = createApp();
const server = app.listen(0);
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');

const response = await fetch(`http://127.0.0.1:${address.port}/api/plan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    destinationId: 'barcelona',
    startDate: '2026-05-11',
    endDate: '2026-05-14',
    budgetTotal: 420,
    preferences: {
      interests: { architecture: 1, 'art-nouveau': 0.9, views: 0.7, food: 0.6, art: 0.5, beaches: -0.3 },
      pace: 'balanced',
      travelers: 2,
      dayStart: '09:00',
      dayEnd: '20:00',
    },
  }),
});
const { itinerary } = (await response.json()) as { itinerary: Itinerary };

console.log(`\n=== ${itinerary.destination.name}  ${itinerary.startDate} to ${itinerary.endDate} ===`);
for (const day of itinerary.days) {
  const w = day.weather;
  console.log(
    `\n${day.date} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.weekday]})  ` +
      (w ? `${w.condition} ${w.tempMinC}-${w.tempMaxC}C rain ${Math.round(w.precipitationChance * 100)}%` : ''),
  );
  for (const item of day.items) {
    const leg = item.arrival;
    console.log(
      `  ${formatClock(item.start)}-${formatClock(item.end)}  ${item.place.name.padEnd(38)} ` +
        `${itinerary.currency}${String(item.cost).padStart(5)}  ` +
        `[${leg?.mode} ${formatDuration(leg?.minutes ?? 0)}]`,
    );
    if (item.reasons.length) console.log(`             why: ${item.reasons.join('; ')}`);
  }
  console.log(
    `  -- day: ${itinerary.currency}${day.totals.cost}, travel ${formatDuration(day.totals.travelMinutes)}, ` +
      `active ${formatDuration(day.totals.activeMinutes)}`,
  );
  for (const note of day.notes) console.log(`  note: ${note}`);
}
console.log(
  `\nTOTAL  ${itinerary.currency}${itinerary.totals.cost} of ${420} (left ${itinerary.currency}${itinerary.totals.budgetRemaining})  ` +
    `${itinerary.totals.placesVisited} places, travel ${formatDuration(itinerary.totals.travelMinutes)}, score ${itinerary.score}`,
);
console.log(`\nnot scheduled (${itinerary.rejected.length}):`);
for (const r of itinerary.rejected) console.log(`  ${r.name.padEnd(38)} ${r.reason}: ${r.detail}`);
server.close();
