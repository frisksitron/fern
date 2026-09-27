import path from 'node:path';

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeRelative(input: string): string {
  if (input.includes('\0') || path.posix.isAbsolute(input) || path.win32.isAbsolute(input))
    throw new Error('Invalid relative path');
  const normalized = input
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
  if (normalized.split('/').includes('..')) throw new Error('Path traversal is not allowed');
  return normalized;
}

/**
 * Normalizes an absolute path for comparison: forward slashes, no trailing separator, and
 * case-folded when it is a Windows drive or UNC path, because those filesystems are
 * case-insensitive. Paths should already be canonical (`realpath`) where aliases matter.
 */
export function comparablePath(input: string): string {
  const slashes = input.replaceAll('\\', '/');
  const trimmed = slashes.replace(/\/+$/, '') || '/';
  return /^[a-z]:/i.test(trimmed) || trimmed.startsWith('//') ? trimmed.toLowerCase() : trimmed;
}

export function isSameOrInside(parent: string, candidate: string): boolean {
  const base = comparablePath(parent);
  const target = comparablePath(candidate);
  return base === target || target.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/** Media roots overlap when one equals or contains the other, which would index files twice. */
export function pathsOverlap(left: string, right: string): boolean {
  return isSameOrInside(left, right) || isSameOrInside(right, left);
}

/** Splits a `BROWSE_ROOTS` value on the platform path delimiter (`:` on POSIX, `;` on Windows). */
export function parseBrowseRoots(value: string | undefined, delimiter = path.delimiter): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}
