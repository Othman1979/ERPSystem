import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expectedSchemaVersion, isSchemaBehind, lastMigrationName } from './schema-version.js';

describe('schema version', () => {
  it('uses the last sorted migration directory as the expected version', () => {
    const migrationsDir = path.resolve(import.meta.dirname, '../../prisma/migrations');
    const latest = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    expect(expectedSchemaVersion()).toBe(latest);
    expect(lastMigrationName(migrationsDir)).toBe(latest);
  });

  it('gates null and behind versions but permits the expected and ahead versions', () => {
    const expected = expectedSchemaVersion();
    expect(isSchemaBehind(null, expected)).toBe(true);
    expect(isSchemaBehind(`${expected.slice(0, -1)}0`, expected)).toBe(true);
    expect(isSchemaBehind(expected, expected)).toBe(false);
    expect(isSchemaBehind(`${expected}z`, expected)).toBe(false);
  });
});
