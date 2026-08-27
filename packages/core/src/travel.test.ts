import { describe, expect, it } from 'vitest';

import { formatDistance, haversineMeters, routeMeters, centroid, boundingBox } from './geo.js';
import { normalizePreferences } from './planner.js';
import { ALL_TRAVEL_MODES, chooseLeg, estimateLeg, TravelMatrix } from './travel.js';
import type { Place, Preferences } from './types.js';

const SAGRADA = { lat: 41.4036, lon: 2.1744 };
const GOTHIC = { lat: 41.3839, lon: 2.1762 };

const preferences = (overrides: Partial<Preferences> = {}) => normalizePreferences(overrides);

describe('geo', () => {
  it('measures a known city distance to within a few percent', () => {
    // Sagrada Familia to the Gothic Quarter is roughly 2.2 km as the crow flies.
    const meters = haversineMeters(SAGRADA, GOTHIC);
    expect(meters).toBeGreaterThan(2000);
    expect(meters).toBeLessThan(2400);
  });

  it('returns zero for a place to itself', () => {
    expect(haversineMeters(SAGRADA, SAGRADA)).toBe(0);
  });

  it('is symmetric', () => {
    expect(haversineMeters(SAGRADA, GOTHIC)).toBeCloseTo(haversineMeters(GOTHIC, SAGRADA), 6);
  });

  it('makes street distance longer than the straight line', () => {
    expect(routeMeters(SAGRADA, GOTHIC)).toBeGreaterThan(haversineMeters(SAGRADA, GOTHIC));
  });

  it('formats distances the way signage does', () => {
    expect(formatDistance(240)).toBe('240 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(24_000)).toBe('24 km');
  });

  it('finds a centroid and a bounding box, and copes with nothing', () => {
    expect(centroid([SAGRADA, GOTHIC])?.lat).toBeCloseTo((SAGRADA.lat + GOTHIC.lat) / 2, 6);
    expect(boundingBox([SAGRADA, GOTHIC])).toEqual({
      minLat: GOTHIC.lat,
      maxLat: SAGRADA.lat,
      minLon: SAGRADA.lon,
      maxLon: GOTHIC.lon,
    });
    expect(centroid([])).toBeNull();
    expect(boundingBox([])).toBeNull();
  });
});

describe('estimateLeg', () => {
  it('makes walking free and driving cost money', () => {
    expect(estimateLeg(SAGRADA, GOTHIC, 'walk', 2).cost).toBe(0);
    expect(estimateLeg(SAGRADA, GOTHIC, 'drive', 2).cost).toBeGreaterThan(0);
  });

  it('charges transit and cycling per person, but driving per party', () => {
    const transitSolo = estimateLeg(SAGRADA, GOTHIC, 'transit', 1).cost;
    const transitFour = estimateLeg(SAGRADA, GOTHIC, 'transit', 4).cost;
    expect(transitFour).toBeCloseTo(transitSolo * 4, 2);

    const driveSolo = estimateLeg(SAGRADA, GOTHIC, 'drive', 1).cost;
    const driveFour = estimateLeg(SAGRADA, GOTHIC, 'drive', 4).cost;
    expect(driveFour).toBeCloseTo(driveSolo, 2);
  });

  it('gives every mode a nonzero duration over a real distance', () => {
    for (const mode of ALL_TRAVEL_MODES) {
      expect(estimateLeg(SAGRADA, GOTHIC, mode, 2).minutes).toBeGreaterThan(0);
    }
  });

  it('includes mode overhead, so a very short transit hop is slower than walking it', () => {
    const nearby = { lat: SAGRADA.lat + 0.0015, lon: SAGRADA.lon };
    expect(estimateLeg(SAGRADA, nearby, 'transit', 2).minutes).toBeGreaterThan(
      estimateLeg(SAGRADA, nearby, 'walk', 2).minutes,
    );
  });
});

describe('chooseLeg', () => {
  it('walks a short hop rather than paying for a ride', () => {
    const nearby = { lat: SAGRADA.lat + 0.004, lon: SAGRADA.lon };
    expect(chooseLeg(SAGRADA, nearby, preferences({ maxWalkMinutes: 25 })).mode).toBe('walk');
  });

  it('takes transit once the walk exceeds what the traveller signed up for', () => {
    const farAway = { lat: SAGRADA.lat + 0.09, lon: SAGRADA.lon };
    expect(chooseLeg(SAGRADA, farAway, preferences({ maxWalkMinutes: 20 })).mode).not.toBe('walk');
  });

  it('will walk further for someone who says they enjoy walking', () => {
    // ~15 minutes on foot: inside a keen walker tolerance, outside a reluctant one.
    const middling = { lat: SAGRADA.lat + 0.0077, lon: SAGRADA.lon };
    expect(chooseLeg(SAGRADA, middling, preferences({ maxWalkMinutes: 10 })).mode).not.toBe('walk');
    expect(chooseLeg(SAGRADA, middling, preferences({ maxWalkMinutes: 60 })).mode).toBe('walk');
  });

  it('takes a decisively faster ride even when the walk is within tolerance', () => {
    // A 40-minute walk against an 18-minute ride: the ride is worth the fare.
    const acrossTown = { lat: SAGRADA.lat + 0.022, lon: SAGRADA.lon };
    expect(chooseLeg(SAGRADA, acrossTown, preferences({ maxWalkMinutes: 60 })).mode).toBe('transit');
  });

  it('falls back to walking when it is the only mode on offer, however long', () => {
    const farAway = { lat: SAGRADA.lat + 0.09, lon: SAGRADA.lon };
    const chosen = chooseLeg(SAGRADA, farAway, preferences({ preferredModes: ['walk'], maxWalkMinutes: 15 }));
    expect(chosen.mode).toBe('walk');
    expect(chosen.minutes).toBeGreaterThan(15);
  });

  it('only offers modes the traveller is willing to use', () => {
    const farAway = { lat: SAGRADA.lat + 0.09, lon: SAGRADA.lon };
    const chosen = chooseLeg(SAGRADA, farAway, preferences({ preferredModes: ['walk', 'cycle'] }));
    expect(['walk', 'cycle']).toContain(chosen.mode);
  });
});

describe('TravelMatrix', () => {
  const asPlace = (id: string, coord: { lat: number; lon: number }): Place => ({
    id,
    name: id,
    category: 'landmark',
    coord,
    dwellMinutes: 60,
    costPerPerson: 0,
    rating: 4,
    tags: [],
    openingHours: { alwaysOpen: true },
    indoor: false,
  });

  it('returns a zero leg from a place to itself', () => {
    const matrix = new TravelMatrix([asPlace('a', SAGRADA)], preferences());
    expect(matrix.between('a', 'a')).toEqual({ mode: 'walk', minutes: 0, meters: 0, cost: 0 });
  });

  it('caches, so repeated lookups agree exactly', () => {
    const matrix = new TravelMatrix([asPlace('a', SAGRADA), asPlace('b', GOTHIC)], preferences());
    expect(matrix.between('a', 'b')).toEqual(matrix.between('a', 'b'));
    expect(matrix.minutes('a', 'b')).toBeGreaterThan(0);
  });

  it('names the place it could not find', () => {
    const matrix = new TravelMatrix([asPlace('a', SAGRADA)], preferences());
    expect(() => matrix.between('a', 'ghost')).toThrow(/ghost/);
    expect(() => matrix.between('ghost', 'a')).toThrow(/ghost/);
  });

  it('accepts places registered after construction', () => {
    const matrix = new TravelMatrix([asPlace('a', SAGRADA)], preferences());
    matrix.register(asPlace('b', GOTHIC));
    expect(matrix.has('b')).toBe(true);
    expect(matrix.leg('a', 'b')).toMatchObject({ fromPlaceId: 'a', toPlaceId: 'b' });
  });
});
