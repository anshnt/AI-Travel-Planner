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

const clock = z
  .string()
  .regex(CLOCK, 'expected a HH:MM time')
  .transform((value) => {
    const [hours, minutes] = value.split(':').map(Number) as [number, number];
    return hours * 60 + minutes;
  });

const isoDate = z.string().regex(ISO_DATE, 'expected a YYYY-MM-DD date');

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
});

export const planRequestSchema = z
  .object({
    destinationId: z.string().min(1),
    startDate: isoDate,
    endDate: isoDate,
    budgetTotal: z.number().min(0).max(10_000_000),
    /** Optional per-day ceiling; derived from the total when omitted. */
    dailyCap: z.number().min(0).optional(),
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

export type PlanRequestInput = z.infer<typeof planRequestSchema>;
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
