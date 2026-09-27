type ByteRange = { readonly start: number; readonly end: number };

/**
 * Parses a single HTTP `Range` header (`bytes=a-b`, `bytes=a-`, or `bytes=-n`) against a file size.
 * Returns null when the range is malformed or unsatisfiable, which callers answer with 416.
 */
export function parseByteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  const [, first, last] = match;
  let start = first ? Number(first) : 0;
  let end = last ? Number(last) : size - 1;
  if (!first && last) {
    start = Math.max(0, size - Number(last));
    end = size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
