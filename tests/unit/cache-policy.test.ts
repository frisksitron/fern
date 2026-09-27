import { describe, expect, it } from 'vitest';
import { selectEvictions } from '../../src/lib/server/media/cache-policy';

const hour = 3_600_000;
const now = 100 * hour;

describe('selectEvictions', () => {
  const items = [
    { key: 'old', bytes: 10, lastUsedMs: now - 80 * hour },
    { key: 'older-protected', bytes: 10, lastUsedMs: now - 90 * hour },
    { key: 'recent-a', bytes: 40, lastUsedMs: now - 2 * hour },
    { key: 'recent-b', bytes: 40, lastUsedMs: now - 1 * hour },
  ];

  it('evicts items past the maximum age but never protected ones', () => {
    expect(
      selectEvictions(items, {
        now,
        maxAgeMs: 72 * hour,
        maxBytes: 1_000,
        protectedKeys: new Set(['older-protected']),
      }),
    ).toEqual(['old']);
  });

  it('evicts least recently used items until the cache fits', () => {
    expect(selectEvictions(items, { now, maxAgeMs: 1_000 * hour, maxBytes: 50, protectedKeys: new Set() })).toEqual([
      'older-protected',
      'old',
      'recent-a',
    ]);
  });

  it('keeps protected items even when the cache stays too large', () => {
    expect(
      selectEvictions(items, {
        now,
        maxAgeMs: 1_000 * hour,
        maxBytes: 0,
        protectedKeys: new Set(items.map((item) => item.key)),
      }),
    ).toEqual([]);
  });
});
