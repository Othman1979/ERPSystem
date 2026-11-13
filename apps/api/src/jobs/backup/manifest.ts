import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** One backup = one folder `backup-YYYYMMDD-HHmmss` (UTC) under BACKUP_DIR (ADR-010 §10.2). */
export const BACKUP_NAME = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
/** A run still writing (or one that crashed): renamed to its final name only when complete. */
export const PARTIAL_PREFIX = '.partial-';

export const DB_FILE = 'database.sql.gz';
export const STORAGE_FILE = 'storage.zip';
export const MANIFEST_FILE = 'manifest.json';

export interface ManifestFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  name: string;
  createdAt: string;
  database: { name: string; server: string };
  /** Applied migrations at backup time: the restored database must have the same. */
  migrations: { count: number; last: string | null };
  storage: { files: number };
  files: ManifestFile[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function backupName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `backup-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** The time a backup folder name stands for, or null for any other name. */
export function backupTime(name: string): Date | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

/**
 * Folders to delete: complete backups older than `keepDays` (the newest is
 * always kept, however old), and partial ones older than a day. Any other
 * folder in BACKUP_DIR is left alone.
 */
export function selectForRemoval(names: string[], now: Date, keepDays: number): string[] {
  const complete = names
    .map((name) => ({ name, at: backupTime(name) }))
    .filter((b): b is { name: string; at: Date } => b.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const cutoff = now.getTime() - keepDays * DAY_MS;
  const old = complete.slice(1).filter((b) => b.at.getTime() < cutoff).map((b) => b.name);
  const stale = names.filter((n) => {
    if (!n.startsWith(PARTIAL_PREFIX)) return false;
    const at = backupTime(n.slice(PARTIAL_PREFIX.length));
    return at !== null && at.getTime() < now.getTime() - DAY_MS;
  });
  return [...old, ...stale];
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
