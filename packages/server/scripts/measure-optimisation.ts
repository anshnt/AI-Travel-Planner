/**
 * Measures what the route-optimisation pass is worth, over every seed
 * destination and a range of trip shapes.
 */
import { formatDuration, planTrip, type PlanRequest } from '@atp/core';
import { DESTINATIONS } from '../src/data/destinations.js';
import { SyntheticWeatherProvider } from '../src/providers/weather.js';

const weatherProvider = new SyntheticWeatherProvider();
const dates = (start: string, days: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

const PROFILES = [
  { name: 'architecture, balanced', interests: { architecture: 1, 'art-nouveau': 0.8, views: 0.6 }, pace: 'balanced' as const },
  { name: 'art + food, packed', interests: { art: 1, food: 0.9, museums: 0.8 }, pace: 'packed' as const },
  { name: 'outdoors, relaxed', interests: { parks: 1, views: 0.9, walking: 0.8 }, pace: 'relaxed' as const },
];

let totalBefore = 0;
let totalAfter = 0;
const rows: string[] = [];

for (const destination of DESTINATIONS) {
  for (const days of [3, 5]) {
    for (const profile of PROFILES) {
      const range = dates('2026-05-11', days);
      const weather = await weatherProvider.forecast(destination.center, range);
      const request: PlanRequest = {
        destination: { name: destination.name, center: destination.center },
        startDate: range[0]!,
        endDate: range[range.length - 1]!,
        budget: { total: destination.suggestedDailyBudget * 2 * days, currency: destination.currency },
        preferences: {
          interests: profile.interests,
          pace: profile.pace,
          dayStart: 9 * 60,
          dayEnd: 22 * 60,
          maxWalkMinutes: 22,
          preferredModes: ['walk', 'transit'],
          avoidCategories: [],
          dietary: [],
          cuisines: [],
          mustSeeIds: [],
          travelers: 2,
          meals: ['lunch', 'dinner'],
          mealWindows: {} as never,
        } as PlanRequest['preferences'],
        candidates: destination.places,
        weather,
      };

      const greedy = planTrip(request, { skipOptimisation: true });
      const optimised = planTrip(request);

      totalBefore += greedy.totals.travelMinutes;
      totalAfter += optimised.totals.travelMinutes;

      const saved = greedy.totals.travelMinutes - optimised.totals.travelMinutes;
      const pct = greedy.totals.travelMinutes > 0 ? (saved / greedy.totals.travelMinutes) * 100 : 0;
      rows.push(
        `${destination.name.padEnd(10)} ${days}d ${profile.name.padEnd(24)} ` +
          `${formatDuration(greedy.totals.travelMinutes).padStart(7)} -> ${formatDuration(optimised.totals.travelMinutes).padStart(7)}  ` +
          `${saved >= 0 ? '-' : '+'}${formatDuration(Math.abs(saved)).padEnd(7)} ${pct.toFixed(1).padStart(5)}%  ` +
          `stops ${greedy.totals.placesVisited}->${optimised.totals.placesVisited}  moves ${optimised.optimisation?.moves.length ?? 0}`,
      );
    }
  }
}

console.log(rows.join('\n'));
const saved = totalBefore - totalAfter;
console.log(
  `\nacross ${rows.length} plans: ${formatDuration(totalBefore)} -> ${formatDuration(totalAfter)} ` +
    `(${saved >= 0 ? 'saved' : 'ADDED'} ${formatDuration(Math.abs(saved))}, ${((saved / totalBefore) * 100).toFixed(1)}%)`,
);
