/**
 * Source scanning for the tenant-isolation guards (ADR-010 §10.4): which
 * files use the unrestricted client, which raw SQL touches tenant tables
 * without tenant_id, which DTOs or route parameters take a tenantId.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TENANT_MODELS } from '../../src/prisma/tenant-prisma.js';

export const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(API_DIR, 'src');

/** Production source files (no tests, no generated client), as paths relative to apps/api with '/'. */
export function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.relative(API_DIR, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .filter((f) => !f.startsWith('src/generated/'))
    .sort();
}

export const read = (file: string) => readFileSync(path.join(API_DIR, file), 'utf8');

/** Table names (@@map) of the tenant-scoped models. */
export function tenantTables(): Set<string> {
  const schema = readFileSync(path.join(API_DIR, 'prisma', 'schema.prisma'), 'utf8');
  const tables = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (!(TENANT_MODELS as readonly string[]).includes(m[1])) continue;
    const map = /@@map\("([^"]+)"\)/.exec(m[2]);
    if (map) tables.add(map[1]);
  }
  return tables;
}

/** Every raw SQL call of a file, parsed or not (the guard checks both counts match). */
export const RAW_CALL = /\$(queryRaw|executeRaw)(Unsafe)?\b/g;

/** Index of the closing quote, skipping escaped ones (\`). */
function closing(source: string, quote: string, from: number): number {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === quote) return i;
  }
  return -1;
}

/**
 * Raw SQL statements of a file: tagged templates and the first argument of
 * the Unsafe calls. An Unsafe call whose SQL is not a literal cannot be
 * checked: it comes back with `literal: false`.
 */
export function rawSql(source: string): { line: number; sql: string; literal: boolean }[] {
  const out: { line: number; sql: string; literal: boolean }[] = [];
  // The type argument may hold parentheses or nested <>: lazily up to the SQL.
  const re = /\$(queryRaw|executeRaw)(Unsafe)?\s*(?:<[\s\S]*?>)?\s*(`|\()/g;
  for (const m of source.matchAll(re)) {
    const line = source.slice(0, m.index).split('\n').length;
    let start = m.index + m[0].length;
    let quote = m[3];
    if (quote === '(') {
      while (/\s/.test(source[start])) start += 1;
      quote = source[start];
      if (!['`', "'", '"'].includes(quote)) {
        out.push({ line, sql: '', literal: false });
        continue;
      }
      start += 1;
    }
    const end = closing(source, quote, start);
    if (end < 0) continue;
    out.push({ line, sql: source.slice(start, end), literal: true });
  }
  return out;
}

/**
 * Whether a file uses the unrestricted client: `.client` on any variable
 * typed PrismaService (whatever its name), or `client` destructured from one.
 */
export function usesSystemPrisma(source: string): boolean {
  const names = [...source.matchAll(/(\w+)\s*:\s*PrismaService\b/g)].map((m) => m[1]);
  return names.some(
    (n) =>
      new RegExp(`\\b${n}\\s*(\\.|\\?\\.)\\s*client\\b`).test(source) ||
      new RegExp(`\\b${n}\\s*\\[\\s*['"]client['"]\\s*\\]`).test(source) ||
      new RegExp(`\\{[^}]*\\bclient\\b[^}]*\\}\\s*=\\s*(this\\.)?${n}\\b`).test(source),
  );
}
