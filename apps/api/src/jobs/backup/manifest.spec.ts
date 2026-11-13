import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupName,
  backupTime,
  encryptionOf,
  PARTIAL_PREFIX,
  resolveBackupFolder,
  selectForRemoval,
  storedName,
} from './manifest.js';

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

describe('manifest formats (ADR-010 §10.2)', () => {
  const base = {
    name: 'backup-20261112-021507',
    createdAt: '2026-11-12T02:15:07.000Z',
    database: { name: 'erp', server: '10.11.0' },
    migrations: { count: 3, last: 'm3' },
    storage: { files: 0 },
    files: [],
  };

  it('names a stored file with the suffix only when it is encrypted', () => {
    expect(storedName('database.sql.gz', true)).toBe('database.sql.gz.enc');
    expect(storedName('storage.zip', false)).toBe('storage.zip');
  });

  it('gives the encryption of a format 2 manifest, and none for format 1', () => {
    const enc = { algorithm: 'aes-256-gcm' as const, keyId: 'abcdef0123456789' };
    expect(encryptionOf({ ...base, format: 2, encryption: enc })).toEqual(enc);
    expect(encryptionOf({ ...base, format: 2, encryption: null })).toBeNull();
    expect(encryptionOf({ ...base, format: 1 })).toBeNull();
  });

  it('resolves latest, a folder name under the root, or a path, and refuses a folder without a manifest', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manifest-root-'));
    try {
      for (const name of ['backup-20261110-021500', 'backup-20261112-021507', 'notes']) {
        mkdirSync(path.join(root, name));
      }
      writeFileSync(path.join(root, 'backup-20261112-021507', 'manifest.json'), '{}');
      writeFileSync(path.join(root, 'backup-20261110-021500', 'manifest.json'), '{}');
      expect(await resolveBackupFolder('latest', root)).toBe(path.join(root, 'backup-20261112-021507'));
      expect(await resolveBackupFolder('backup-20261110-021500', root)).toBe(path.join(root, 'backup-20261110-021500'));
      expect(await resolveBackupFolder(path.join(root, 'backup-20261110-021500'), root)).toBe(
        path.join(root, 'backup-20261110-021500'),
      );
      await expect(resolveBackupFolder('notes', root)).rejects.toThrow(/no manifest\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
