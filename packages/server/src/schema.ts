import { z } from 'zod';

const CLOCK = /^\d{1,2}:\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const travelMode = z.enum(['walk', 'cycle', 'transit', 'drive']);

const placeCategory = z.enum([
  'museum',
  'gallery',
  'landmark',
  'park',
  'viewpoint',
  'market',
  'shopping',
  'nightlife',
  'beach',
  'religious',
  'experience',
  'restaurant',
  'cafe',
  'lodging',
]);

const dietaryTag = z.enum(['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free']);

const mealKind = z.enum(['breakfast', 'lunch', 'dinner']);

const clock = z
  .string()
  .regex(CLOCK, 'expected a HH:MM time')
  .transform((value) => {
    const [hours, minutes] = value.split(':').map(Number) as [number, number];
    return hours * 60 + minutes;
  });

const isoDate = z.string().regex(ISO_DATE, 'expected a YYYY-MM-DD date');

/** A window a meal may start in, given as clock strings. */
const mealWindow = z
  .object({ start: clock, end: clock })
  .refine((value) => value.end > value.start, { message: 'the window must end after it starts' });

export const preferencesSchema = z.object({
  /** Tag to appetite, -1 (avoid) through 0 (neutral) to 1 (love). */
  interests: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  pace: z.enum(['relaxed', 'balanced', 'packed']).default('balanced'),
  dayStart: clock.default(9 * 60),
  dayEnd: clock.default(20 * 60),
  maxWalkMinutes: z.number().int().min(5).max(180).default(22),
  preferredModes: z.array(travelMode).min(1).default(['walk', 'transit']),
  avoidCategories: z.array(placeCategory).default([]),
  dietary: z.array(dietaryTag).default([]),
  cuisines: z.array(z.string()).default([]),
  mustSeeIds: z.array(z.string()).default([]),
  travelers: z.number().int().min(1).max(20).default(2),
  /** Which meals to book. Omit for lunch and dinner; send [] for none. */
  meals: z.array(mealKind).max(3).optional(),
  /** Override any subset of the meal windows, e.g. just a later dinner. */
  mealWindows: z
    .object({
      breakfast: mealWindow.optional(),
      lunch: mealWindow.optional(),
      dinner: mealWindow.optional(),
    })
    .optional(),
});

export const planRequestSchema = z
  .object({
    destinationId: z.string().min(1),
    startDate: isoDate,
    endDate: isoDate,
    budgetTotal: z.number().min(0).max(10_000_000),
    /** Optional per-day ceiling; derived from the total when omitted. */
    dailyCap: z.number().min(0).optional(),
    /** Fraction of the budget held back for food, 0-1. Defaults to a sensible share. */
    foodShare: z.number().min(0).max(1).optional(),
    preferences: preferencesSchema.optional(),
    /** Restrict the candidate pool, e.g. after the traveller deselects places. */
    includePlaceIds: z.array(z.string()).optional(),
    lodgingPlaceId: z.string().optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate must not precede startDate',
    path: ['endDate'],
  })
  .refine(
    (value) => {
      const start = Date.parse(`${value.startDate}T00:00:00Z`);
      const end = Date.parse(`${value.endDate}T00:00:00Z`);
      return (end - start) / 86_400_000 <= 20;
    },
    { message: 'trips longer than 21 days are not supported', path: ['endDate'] },
  );

/** Where the traveller is in the trip. */
const momentSchema = z.object({ date: isoDate, minute: clock });

const dailyWeatherSchema = z.object({
  date: isoDate,
  condition: z.enum(['clear', 'partly-cloudy', 'cloudy', 'rain', 'heavy-rain', 'snow', 'storm', 'fog']),
  tempMinC: z.number(),
  tempMaxC: z.number(),
  precipitationChance: z.number().min(0).max(1),
  precipitationMm: z.number().min(0),
  windKph: z.number().min(0),
  hourly: z
    .array(
      z.object({
        hour: z.number().int().min(0).max(23),
        tempC: z.number(),
        precipitationChance: z.number().min(0).max(1),
        precipitationMm: z.number().min(0),
      }),
    )
    .optional(),
});

const disruptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running-late'), minutes: z.number().int().min(1).max(24 * 60) }),
  z.object({ kind: z.literal('place-closed'), placeId: z.string().min(1), date: isoDate.optional() }),
  z.object({ kind: z.literal('forecast-changed'), weather: z.array(dailyWeatherSchema).min(1) }),
  z.object({ kind: z.literal('budget-changed'), total: z.number().min(0).max(10_000_000) }),
  z.object({ kind: z.literal('pin'), placeId: z.string().min(1) }),
  z.object({ kind: z.literal('unpin'), placeId: z.string().min(1) }),
  z.object({ kind: z.literal('move'), placeId: z.string().min(1), toDate: isoDate }),
  z.object({ kind: z.literal('drop'), placeId: z.string().min(1) }),
  z.object({ kind: z.literal('add'), placeId: z.string().min(1) }),
]);

/**
 * A re-plan carries the original request rather than a server-side session.
 *
 * Keeping the server stateless means the client owns the plan, which is what
 * makes "undo" and "try this instead" the client's business rather than a
 * synchronisation problem.
 */
export const replanRequestSchema = planRequestSchema.safeExtend({
  /** Which stops are already scheduled, so the server can rebuild the itinerary. */
  scheduled: z
    .array(
      z.object({
        date: isoDate,
        placeId: z.string().min(1),
        start: z.number().int().min(0).max(2 * 24 * 60),
        kind: z.enum(['activity', 'meal', 'lodging']).default('activity'),
        mealKind: z.enum(['breakfast', 'lunch', 'dinner']).optional(),
      }),
    )
    .max(400),
  now: momentSchema.optional(),
  disruptions: z.array(disruptionSchema).max(40).default([]),
  pinned: z.array(z.string()).max(200).default([]),
});

export type PlanRequestInput = z.infer<typeof planRequestSchema>;
export type ReplanRequestInput = z.infer<typeof replanRequestSchema>;
export type PreferencesInput = z.infer<typeof preferencesSchema>;

/** The preference set implied by sending nothing at all. */
export function defaultPreferencesInput(): PreferencesInput {
  return preferencesSchema.parse({});
}

/** Flattens a Zod error into something an API client can act on. */
export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}
