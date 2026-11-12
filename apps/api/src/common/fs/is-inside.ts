import path from 'node:path';

/** Whether `child` is `parent` itself or somewhere inside it (both resolved paths). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether either folder contains the other. */
export function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}
