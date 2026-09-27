/** The most IDs one Zero query takes; longer lists are split across several queries. */
export const QUERY_ID_LIMIT = 500;

/** Music search shows at most this many tracks. */
export const MUSIC_SEARCH_LIMIT = 100;

/**
 * An ILIKE pattern matching `text` anywhere. LIKE wildcards and the escape character are dropped
 * from the search text rather than escaped, so they match nothing special on any Zero backend.
 */
export function likeContaining(text: string) {
  return `%${text.replace(/[%_\\]/g, '')}%`;
}
