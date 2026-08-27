import type { Coord } from './types.js';

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two coordinates. */
export function haversineMeters(from: Coord, to: Coord): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance actually walked or driven, which is longer than the straight line
 * because streets rarely point where you want to go.
 *
 * 1.35 is a commonly used average detour factor for dense street grids; it is
 * the difference between a plan that looks right on paper and one that survives
 * contact with the pavement. A real routing provider overrides this whenever
 * one is configured.
 */
export const STREET_DETOUR_FACTOR = 1.35;

export function routeMeters(from: Coord, to: Coord): number {
  return haversineMeters(from, to) * STREET_DETOUR_FACTOR;
}

export type BoundingBox = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

export function boundingBox(coords: readonly Coord[]): BoundingBox | null {
  if (coords.length === 0) return null;
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const coord of coords) {
    if (coord.lat < minLat) minLat = coord.lat;
    if (coord.lat > maxLat) maxLat = coord.lat;
    if (coord.lon < minLon) minLon = coord.lon;
    if (coord.lon > maxLon) maxLon = coord.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

export function centroid(coords: readonly Coord[]): Coord | null {
  if (coords.length === 0) return null;
  const sum = coords.reduce((acc, coord) => ({ lat: acc.lat + coord.lat, lon: acc.lon + coord.lon }), {
    lat: 0,
    lon: 0,
  });
  return { lat: sum.lat / coords.length, lon: sum.lon / coords.length };
}

export function formatDistance(meters: number): string {
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}
