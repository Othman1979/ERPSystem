import { backupName, backupTime, PARTIAL_PREFIX, selectForRemoval } from './manifest.js';

describe('backup names and rotation (ADR-010 §10.2)', () => {
  it('names a backup by its UTC time, and reads the time back', () => {
    const at = new Date(Date.UTC(2026, 10, 12, 2, 15, 7));
    expect(backupName(at)).toBe('backup-20261112-021507');
    expect(backupTime('backup-20261112-021507')?.toISOString()).toBe(at.toISOString());
    expect(backupTime('backup-2026-11-12')).toBeNull();
    expect(backupTime('notes')).toBeNull();
  });

  const now = new Date(Date.UTC(2026, 10, 30, 3, 0, 0));
  const day = (d: number) => backupName(new Date(Date.UTC(2026, 10, d, 2, 15, 0)));

  it('removes backups older than the kept days, never the newest, never other folders', () => {
    // 14 days back from Nov 30 03:00 is Nov 16 03:00: the Nov 16 02:15 backup is just past it.
    const names = [day(1), day(16), day(17), day(29), 'keep-me', 'backup-old-style'];
    expect(selectForRemoval(names, now, 14).sort()).toEqual([day(1), day(16)].sort());
    // Only very old backups left: the newest one stays anyway.
    expect(selectForRemoval([day(1), day(2)], now, 14)).toEqual([day(1)]);
    expect(selectForRemoval([day(1)], now, 14)).toEqual([]);
  });

  it('clears partial folders from crashed runs after a day, not a run in progress', () => {
    const crashed = `${PARTIAL_PREFIX}${day(28)}`;
    const running = `${PARTIAL_PREFIX}${backupName(new Date(now.getTime() - 10 * 60_000))}`;
    expect(selectForRemoval([day(29), crashed, running], now, 14)).toEqual([crashed]);
  });
});
