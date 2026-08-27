/**
 * Domain model for the travel planner.
 *
 * Two conventions run through the whole engine:
 *  - all clock times are `MinuteOfDay` (minutes since local midnight), never Date
 *    objects, so scheduling arithmetic stays timezone- and DST-free;
 *  - all dates are ISO calendar days (`YYYY-MM-DD`) in the destination's local
 *    calendar.
 */

export type Coord = {
  lat: number;
  lon: number;
};

/** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Minutes since local midnight. 540 = 09:00. May exceed 1440 for closing times past midnight. */
export type MinuteOfDay = number;

export type TimeWindow = {
  start: MinuteOfDay;
  end: MinuteOfDay;
};

/**
 * Weekly opening pattern plus date-specific exceptions.
 *
 * `weekly` holds one entry per weekday; an empty array means closed all day.
 * `exceptions` overrides the weekly pattern for a specific ISO date — an empty
 * array there marks a public-holiday closure.
 */
export type OpeningHours = {
  alwaysOpen?: boolean;
  weekly?: Partial<Record<Weekday, TimeWindow[]>>;
  exceptions?: Record<string, TimeWindow[]>;
};

export type PlaceCategory =
  | 'museum'
  | 'gallery'
  | 'landmark'
  | 'park'
  | 'viewpoint'
  | 'market'
  | 'shopping'
  | 'nightlife'
  | 'beach'
  | 'religious'
  | 'experience'
  | 'restaurant'
  | 'cafe'
  | 'lodging';

export type MealKind = 'breakfast' | 'lunch' | 'dinner';

export type DietaryTag = 'vegetarian' | 'vegan' | 'halal' | 'kosher' | 'gluten-free' | 'dairy-free';

/** 1 = cheap eats … 4 = fine dining, following the familiar price-level convention. */
export type PriceLevel = 1 | 2 | 3 | 4;

export type MealProfile = {
  kinds: MealKind[];
  priceLevel: PriceLevel;
  cuisines: string[];
  dietary: DietaryTag[];
  /** Typical cost per person, in the trip currency. */
  costPerPerson: number;
};

/** A candidate stop: an attraction, a restaurant, or the trip's lodging. */
export type Place = {
  id: string;
  name: string;
  category: PlaceCategory;
  coord: Coord;
  /** How long a visit typically takes, in minutes. */
  dwellMinutes: number;
  /** Entry / ticket cost per person in the trip currency. 0 for free places. */
  costPerPerson: number;
  /** Crowd rating on a 0–5 scale; used as a mild tie-breaker, never as the main signal. */
  rating: number;
  /** Interest tags matched against the traveller's declared interests. */
  tags: string[];
  openingHours: OpeningHours;
  /** True when the visit is substantially under cover, and so rain-proof. */
  indoor: boolean;
  description?: string;
  address?: string;
  /** Present on restaurants and cafes. */
  meal?: MealProfile;
};

export type TravelMode = 'walk' | 'cycle' | 'transit' | 'drive';

export type TravelLeg = {
  fromPlaceId: string;
  toPlaceId: string;
  mode: TravelMode;
  minutes: number;
  meters: number;
  /** Fare or fuel cost for the whole party. */
  cost: number;
};

export type Pace = 'relaxed' | 'balanced' | 'packed';

export type Preferences = {
  /** Tag → appetite, from -1 (actively avoid) through 0 (neutral) to 1 (love). */
  interests: Record<string, number>;
  pace: Pace;
  /** Earliest the traveller wants to be out, and the latest they want to be back. */
  dayStart: MinuteOfDay;
  dayEnd: MinuteOfDay;
  /** Hard ceiling on a single walking leg before another mode is preferred. */
  maxWalkMinutes: number;
  preferredModes: TravelMode[];
  avoidCategories: PlaceCategory[];
  dietary: DietaryTag[];
  cuisines: string[];
  /** Places that must appear in the plan, by id. */
  mustSeeIds: string[];
  travelers: number;
};

export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'rain' | 'heavy-rain' | 'snow' | 'storm' | 'fog';

export type HourlyWeather = {
  /** Hour of the local day, 0–23. */
  hour: number;
  tempC: number;
  /** 0–1. */
  precipitationChance: number;
  precipitationMm: number;
};

export type DailyWeather = {
  date: string;
  condition: WeatherCondition;
  tempMinC: number;
  tempMaxC: number;
  /** 0–1 chance of measurable precipitation at some point in the day. */
  precipitationChance: number;
  precipitationMm: number;
  windKph: number;
  hourly?: HourlyWeather[];
};

export type Budget = {
  /** Total spendable on activities, food and local transport, for the whole party. */
  total: number;
  currency: string;
  /** Optional soft ceiling per day; derived from `total` when absent. */
  dailyCap?: number;
};

export type PlanRequest = {
  destination: {
    name: string;
    center: Coord;
    /** IANA timezone, carried for display only — the engine works in local minutes. */
    timezone?: string;
  };
  /** Inclusive ISO date range. */
  startDate: string;
  endDate: string;
  budget: Budget;
  preferences: Preferences;
  /** The pool the planner selects from. */
  candidates: Place[];
  /** One entry per trip day when available; missing days are planned weather-blind. */
  weather?: DailyWeather[];
  /** Where the traveller sleeps: the anchor each day starts and ends at. */
  lodging?: Place;
  /** Seeds the deterministic tie-breaking, so the same request always replans identically. */
  seed?: number;
};

export type ItemKind = 'activity' | 'meal' | 'lodging';

export type ScheduledItem = {
  placeId: string;
  place: Place;
  kind: ItemKind;
  start: MinuteOfDay;
  end: MinuteOfDay;
  /** Cost for the whole party. */
  cost: number;
  /** The journey that got the traveller here from the previous item. */
  arrival?: TravelLeg;
  /** Human-readable justifications, surfaced in the UI so the plan explains itself. */
  reasons: string[];
  /**
   * Things worth knowing before setting off, as distinct from reasons this stop
   * was chosen: an exposed viewpoint in a high wind, a park under a shower.
   */
  cautions: string[];
  /** Pinned by the traveller: the planner may reorder around it but never drops it. */
  locked?: boolean;
};

export type DayTotals = {
  cost: number;
  travelMinutes: number;
  walkMinutes: number;
  /** Time actually spent at places, excluding travel and gaps. */
  activeMinutes: number;
  distanceMeters: number;
};

export type DayPlan = {
  date: string;
  weekday: Weekday;
  items: ScheduledItem[];
  weather?: DailyWeather;
  totals: DayTotals;
  /** Day-level advisories, e.g. "rain all afternoon, so museums moved later". */
  notes: string[];
  /** The journey home at the end of the day, when the trip has a base to return to. */
  returnToBase?: TravelLeg;
};

export type RejectionReason =
  /** Shut every day of the trip. */
  | 'closed-on-all-days'
  /** Wanted, but no day had an opening it fitted into. */
  | 'no-feasible-slot'
  /** Wanted and available, but the money ran out. */
  | 'over-budget'
  /** In a category the traveller asked to skip. */
  | 'avoided-category'
  /** Scored against the traveller's stated tastes. */
  | 'disliked';

export type Rejection = {
  placeId: string;
  name: string;
  reason: RejectionReason;
  detail?: string;
};

export type ItineraryTotals = DayTotals & {
  /** Budget left over across the whole trip. */
  budgetRemaining: number;
  placesVisited: number;
};

export type Itinerary = {
  destination: PlanRequest['destination'];
  startDate: string;
  endDate: string;
  currency: string;
  days: DayPlan[];
  totals: ItineraryTotals;
  /** Objective value of the plan; higher is better. Only comparable between plans of the same request. */
  score: number;
  /** Candidates the planner considered and passed on, with the reason why. */
  rejected: Rejection[];
};
