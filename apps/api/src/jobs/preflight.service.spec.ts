import { backupAgeLevel, compareMigrations, diskLevel } from './preflight.service.js';

describe('preflight: disk space', () => {
  const GIB = 1024 ** 3;

  it('is an error below 1 GiB free, a warning below 5 GiB, and fine above', () => {
    expect(diskLevel(0)).toBe('error');
    expect(diskLevel(GIB - 1)).toBe('error');
    expect(diskLevel(GIB)).toBe('warn');
    expect(diskLevel(5 * GIB - 1)).toBe('warn');
    expect(diskLevel(5 * GIB)).toBe('info');
    expect(diskLevel(120 * GIB)).toBe('info');
  });
});

describe('preflight: backup age (ADR-010 §10.2)', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it('no backup at all is a warning, in production too', () => {
    expect(backupAgeLevel(null, now, true)).toMatchObject({ level: 'warn' });
    expect(backupAgeLevel(null, now, false)).toMatchObject({ level: 'warn', detail: expect.stringContaining('job:backup') });
  });

  it('a backup within 26 hours is fine, with its age in hours', () => {
    expect(backupAgeLevel(hoursAgo(3), now, true)).toEqual({ level: 'info', detail: 'newest backup 3.0 h old' });
    expect(backupAgeLevel(hoursAgo(26), now, true).level).toBe('info');
  });

  it('older than 26 hours is an error in production and a warning elsewhere', () => {
    expect(backupAgeLevel(hoursAgo(26.5), now, true).level).toBe('error');
    expect(backupAgeLevel(hoursAgo(26.5), now, false).level).toBe('warn');
  });
});

describe('preflight: migrations (ADR-010 §10.1)', () => {
  const at = new Date('2026-11-11T00:00:00Z');

  it('lists folders not applied, and rows that started but never finished', () => {
    const result = compareMigrations(
      ['20260101_a', '20260201_b', '20260301_c'],
      [
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
        { migration_name: '20260201_b', finished_at: null, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: ['20260201_b', '20260301_c'], failed: ['20260201_b'] });
  });

  it('a rolled-back attempt is neither applied nor failed', () => {
    const result = compareMigrations(
      ['20260101_a'],
      [
        { migration_name: '20260101_a', finished_at: null, rolled_back_at: at },
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: [], failed: [] });
  });
});
