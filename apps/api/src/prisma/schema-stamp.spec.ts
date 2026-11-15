import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCHEMA_STAMP_FILE, schemaHash } from './schema-stamp.js';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'prisma-stamp.mjs');

describe('the Prisma client stamp (preflight prisma-client)', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-stamp-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes the schema text, the same with CRLF or LF line endings', () => {
    expect(schemaHash('model A {\n  id Int @id\n}\n')).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaHash('model A {\r\n  id Int @id\r\n}\r\n')).toBe(schemaHash('model A {\n  id Int @id\n}\n'));
    expect(schemaHash('model A {}\n')).not.toBe(schemaHash('model B {}\n'));
  });

  it('scripts/prisma-stamp.mjs writes the hash preflight computes', async () => {
    const schema = path.join(dir, 'schema.prisma');
    const text = 'generator client {\r\n  provider = "prisma-client"\r\n}\r\n';
    await writeFile(schema, text);
    await promisify(execFile)('node', [SCRIPT, schema, dir]);
    expect((await readFile(path.join(dir, SCHEMA_STAMP_FILE), 'utf8')).trim()).toBe(schemaHash(text));
  });
});
