import path from 'node:path';
import { isInside, overlaps } from './is-inside.js';

describe('isInside and overlaps (backup folder placement)', () => {
  const a = path.resolve('/srv/erp/a');

  it('treats the same folder and its children as inside', () => {
    expect(isInside(a, a)).toBe(true);
    expect(isInside(path.resolve(a, 'b'), a)).toBe(true);
  });

  it('treats a parent, a sibling sharing the name prefix, and a dot-dot folder name correctly', () => {
    expect(isInside(path.resolve('/srv/erp'), a)).toBe(false);
    expect(isInside(path.resolve('/srv/erp/a2'), a)).toBe(false);
    // A child whose name starts with ".." is inside, not outside.
    expect(isInside(path.resolve(a, '..backups'), a)).toBe(true);
    // A real climb out of the folder is outside.
    expect(isInside(path.resolve(a, '../b'), a)).toBe(false);
  });

  it('detects overlap in either direction, but not for siblings', () => {
    expect(overlaps(a, path.resolve(a, 'b'))).toBe(true);
    expect(overlaps(path.resolve(a, 'b'), a)).toBe(true);
    expect(overlaps(a, path.resolve('/srv/erp/a2'))).toBe(false);
  });
});
