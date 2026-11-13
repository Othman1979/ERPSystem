import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import mariadb from 'mariadb';

/** A MariaDB/MySQL connection as the command-line tools need it. */
export interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** DATABASE_URL (mysql://user:pass@host:port/db) → its parts. */
export function dbTarget(url: string): DbTarget {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  // Names go to the client tools as arguments: letters, digits, underscore only (as hosting panels name them), so nothing needs quoting.
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`Unsupported database name "${database}"`);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

/** Whether two targets are the same database on the same server. */
export function sameDatabase(a: DbTarget, b: DbTarget): boolean {
  const host = (h: string) => (h === 'localhost' ? '127.0.0.1' : h.toLowerCase());
  return host(a.host) === host(b.host) && a.port === b.port && a.database.toLowerCase() === b.database.toLowerCase();
}

/** An option-file value: quoted, with backslashes and quotes escaped. */
function optionValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Whether the server offers TLS (`have_ssl` = YES). Asked over the app's own
 * driver, which connects without TLS. When the server cannot answer (MySQL
 * without the variable, an unexpected error), the tools keep their defaults.
 */
export async function serverOffersTls(target: DbTarget): Promise<boolean> {
  try {
    const conn = await mariadb.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
    });
    try {
      const [row] = (await conn.query('SELECT @@have_ssl AS tls')) as { tls: string | null }[];
      return String(row?.tls ?? '').toUpperCase() === 'YES';
    } finally {
      await conn.end();
    }
  } catch {
    return true;
  }
}

/** The `[client]` option file the tools read (see withOptionFile). */
export function optionFileBody(target: DbTarget, serverTls: boolean): string {
  return [
    '[client]',
    // TCP to host:port, as the app's driver connects. Without it the tools
    // take host=localhost to mean the local Unix socket, which a database in
    // a container (CI) or on another socket path does not have.
    'protocol=TCP',
    `host=${optionValue(target.host)}`,
    `port=${target.port}`,
    `user=${optionValue(target.user)}`,
    `password=${optionValue(target.password)}`,
    // MariaDB clients 11.4+ require TLS by default and refuse a server
    // without it ("SSL is required, but the server does not support it"):
    // an 11.x client against a 10.11 server, as on the supported range's
    // floor (ADR-019). Plain only then, as the app's driver connects; a
    // server that offers TLS keeps the client's TLS and verification.
    // `loose-`: a client that does not know the option ignores it.
    ...(serverTls ? [] : ['loose-skip-ssl']),
    '',
  ].join('\n');
}

/**
 * Runs `fn` with a private option file holding the credentials, so the
 * password is never on a command line (visible to other users in `ps`) or
 * in the environment. The file is removed afterwards.
 */
export async function withOptionFile<T>(
  target: DbTarget,
  fn: (file: string) => Promise<T>,
  serverTls?: boolean,
): Promise<T> {
  const file = path.join(os.tmpdir(), `erp-db-${randomUUID()}.cnf`);
  const body = optionFileBody(target, serverTls ?? (await serverOffersTls(target)));
  await writeFile(file, body, { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Starts a client tool (mysqldump, mysql). The caller connects its stdin /
 * stdout with stream.pipeline (so a stream error is an error, not a crash).
 * `done` resolves when the tool exits 0 and rejects with the first lines of
 * its stderr otherwise (never the password: it is not on the command line).
 */
export function runTool(
  bin: string,
  args: string[],
  opts: { stdin?: boolean } = {},
): { done: Promise<void>; stdin: Writable | null; stdout: Readable } {
  const child = spawn(bin, args, { stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  // stdout/stderr are pipes (above): never null here.
  const stdout = child.stdout!;
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`Cannot run ${bin}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exited with ${code}: ${stderr.trim().split('\n').slice(0, 3).join(' | ')}`));
    });
  });
  return { done, stdin: child.stdin, stdout };
}

/** Waits for all; then fails with the first failure (so no stream is left writing). */
export async function allOrFirstError(work: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** The first line of an error, for a one-line report. */
export function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

/** `<bin> --version`, or null when it cannot run. */
export async function toolVersion(bin: string): Promise<string | null> {
  const { done, stdout } = runTool(bin, ['--version']);
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  try {
    await done;
    return out.trim().split('\n')[0];
  } catch {
    return null;
  }
}
