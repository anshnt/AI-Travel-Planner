import { describe, expect, it } from 'vitest';

import { normalizePreferences } from './planner.js';
import {
  explainScore,
  formatList,
  interestScore,
  isExcluded,
  paceProfile,
  ratingScore,
  scorePlace,
  valueScore,
} from './scoring.js';
import type { Place, Preferences } from './types.js';

function place(overrides: Partial<Place> & Pick<Place, 'id'>): Place {
  return {
    name: overrides.id,
    category: 'museum',
    coord: { lat: 41.4, lon: 2.17 },
    dwellMinutes: 90,
    costPerPerson: 0,
    rating: 4,
    tags: [],
    openingHours: { alwaysOpen: true },
    indoor: true,
    ...overrides,
  };
}

const preferences = (overrides: Partial<Preferences> = {}) => normalizePreferences(overrides);

describe('interestScore', () => {
  it('is neutral when nothing matches', () => {
    expect(interestScore(place({ id: 'a', tags: ['botany'] }), preferences({ interests: { art: 1 } }))).toBe(0);
  });

  it('rises with a declared interest', () => {
    expect(interestScore(place({ id: 'a', tags: ['art'] }), preferences({ interests: { art: 1 } }))).toBe(1);
  });

  it('matches tags case-insensitively', () => {
    expect(interestScore(place({ id: 'a', tags: ['Art'] }), preferences({ interests: { ART: 1 } }))).toBe(1);
  });

  it('averages rather than sums, so a broadly tagged place does not run away with it', () => {
    const focused = place({ id: 'focused', tags: ['art'] });
    const broad = place({ id: 'broad', tags: ['art', 'art-nouveau', 'architecture'] });
    const prefs = preferences({ interests: { art: 1, 'art-nouveau': 0.3, architecture: 0.3 } });
    expect(interestScore(focused, prefs)).toBeGreaterThan(interestScore(broad, prefs));
  });

  it('lets a dislike pull a partly liked place back down', () => {
    const prefs = preferences({ interests: { art: 1, crowds: -1 } });
    expect(interestScore(place({ id: 'a', tags: ['art', 'crowds'] }), prefs)).toBe(0);
  });
});

describe('valueScore', () => {
  it('rates free places top', () => {
    expect(valueScore(place({ id: 'a', costPerPerson: 0 }), 2)).toBe(1);
  });

  it('falls as the ticket price rises', () => {
    const cheap = valueScore(place({ id: 'a', costPerPerson: 8 }), 2);
    const dear = valueScore(place({ id: 'b', costPerPerson: 40 }), 2);
    expect(cheap).toBeGreaterThan(dear);
  });

  it('forgives a high price on a long visit', () => {
    const quick = valueScore(place({ id: 'a', costPerPerson: 25, dwellMinutes: 30 }), 2);
    const lengthy = valueScore(place({ id: 'b', costPerPerson: 25, dwellMinutes: 180 }), 2);
    expect(lengthy).toBeGreaterThan(quick);
  });

  it('weighs price more heavily for a large party', () => {
    const pricey = place({ id: 'a', costPerPerson: 30 });
    expect(valueScore(pricey, 4)).toBeLessThan(valueScore(pricey, 2));
  });

  it('never goes negative, however dear the ticket', () => {
    expect(valueScore(place({ id: 'a', costPerPerson: 10_000, dwellMinutes: 30 }), 4)).toBe(0);
  });
});

describe('ratingScore', () => {
  it('normalises a five-point rating to 0-1', () => {
    expect(ratingScore(place({ id: 'a', rating: 5 }))).toBe(1);
    expect(ratingScore(place({ id: 'a', rating: 2.5 }))).toBe(0.5);
    expect(ratingScore(place({ id: 'a', rating: 0 }))).toBe(0);
  });
});

describe('scorePlace', () => {
  it('lets interest outweigh reputation', () => {
    const loved = place({ id: 'loved', rating: 3.2, tags: ['textiles'] });
    const famous = place({ id: 'famous', rating: 4.9, tags: ['nightlife'] });
    const prefs = preferences({ interests: { textiles: 1 } });
    expect(scorePlace(loved, prefs).total).toBeGreaterThan(scorePlace(famous, prefs).total);
  });

  it('reports the terms that made up the total', () => {
    const breakdown = scorePlace(place({ id: 'a', rating: 4, tags: ['art'] }), preferences({ interests: { art: 1 } }));
    expect(breakdown.interest).toBe(1);
    expect(breakdown.rating).toBeCloseTo(0.8, 5);
    expect(breakdown.value).toBe(1);
    expect(breakdown.total).toBeGreaterThan(0.9);
  });
});

describe('isExcluded', () => {
  it('excludes avoided categories', () => {
    expect(isExcluded(place({ id: 'a', category: 'nightlife' }), preferences({ avoidCategories: ['nightlife'] }))).toBe(
      true,
    );
  });

  it('excludes a strongly disliked place', () => {
    expect(isExcluded(place({ id: 'a', tags: ['queues'] }), preferences({ interests: { queues: -1 } }))).toBe(true);
  });

  it('tolerates a mild dislike', () => {
    expect(isExcluded(place({ id: 'a', tags: ['queues'] }), preferences({ interests: { queues: -0.4 } }))).toBe(false);
  });

  it('lets a must-see override every exclusion', () => {
    const prefs = preferences({ avoidCategories: ['nightlife'], interests: { queues: -1 }, mustSeeIds: ['a'] });
    expect(isExcluded(place({ id: 'a', category: 'nightlife', tags: ['queues'] }), prefs)).toBe(false);
  });
});

describe('explainScore', () => {
  it('names the matching interests', () => {
    const reasons = explainScore(place({ id: 'a', tags: ['art', 'architecture'] }), preferences({ interests: { art: 1, architecture: 0.8 } }));
    expect(reasons.join(' ')).toMatch(/matches your interest in art and architecture/);
  });

  it('mentions a free entry and a stellar rating', () => {
    const reasons = explainScore(place({ id: 'a', rating: 4.8, costPerPerson: 0 }), preferences());
    expect(reasons.join(' ')).toMatch(/very highly rated/);
    expect(reasons.join(' ')).toMatch(/free to enter/);
  });

  it('leads with the must-see flag', () => {
    expect(explainScore(place({ id: 'a' }), preferences({ mustSeeIds: ['a'] }))[0]).toMatch(/must-see/);
  });

  it('says nothing rather than inventing a reason', () => {
    expect(explainScore(place({ id: 'a', rating: 3, costPerPerson: 30, dwellMinutes: 30 }), preferences())).toEqual([]);
  });
});

describe('formatList', () => {
  it('reads like English', () => {
    expect(formatList([])).toBe('');
    expect(formatList(['art'])).toBe('art');
    expect(formatList(['art', 'food'])).toBe('art and food');
    expect(formatList(['art', 'food', 'views'])).toBe('art, food and views');
  });
});

describe('paceProfile', () => {
  it('gets busier from relaxed to packed', () => {
    expect(paceProfile('relaxed').maxStopsPerDay).toBeLessThan(paceProfile('balanced').maxStopsPerDay);
    expect(paceProfile('balanced').maxStopsPerDay).toBeLessThan(paceProfile('packed').maxStopsPerDay);
    expect(paceProfile('relaxed').bufferMinutes).toBeGreaterThan(paceProfile('packed').bufferMinutes);
  });
});
