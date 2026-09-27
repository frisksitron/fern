type CacheItem = {
  readonly key: string;
  readonly bytes: number;
  /** Last use: HLS sessions and thumbnails touch their files when served. */
  readonly lastUsedMs: number;
};

type CachePolicy = {
  readonly now: number;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  /** Keys in use right now (being generated or recently served), which must never be evicted. */
  readonly protectedKeys: ReadonlySet<string>;
};

/**
 * Chooses what to delete: everything unused for longer than the maximum age, then the least
 * recently used items until the cache fits. Protected items are never chosen, even if the cache
 * stays over its size target as a result.
 */
export function selectEvictions(items: readonly CacheItem[], policy: CachePolicy): string[] {
  const cutoff = policy.now - policy.maxAgeMs;
  let total = items.reduce((sum, item) => sum + item.bytes, 0);
  const evicted: string[] = [];
  for (const item of [...items].sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
    if (policy.protectedKeys.has(item.key)) continue;
    if (item.lastUsedMs < cutoff || total > policy.maxBytes) {
      evicted.push(item.key);
      total -= item.bytes;
    }
  }
  return evicted;
}
