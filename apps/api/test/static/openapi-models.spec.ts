/**
 * OpenAPI response models, static checks (PLAT-15):
 *  - `src/common/openapi/prisma-models.ts` is what the renderer makes of
 *    `prisma/schema.prisma` now (run `pnpm --filter api openapi:models`);
 *  - no two exported DTO classes (request or response) share a name: OpenAPI
 *    keys schemas by class name, so a second `LineDto` would silently replace
 *    the first in the document and in the generated client.
 */
import { readFileSync } from 'node:fs';
import { MODELS_FILE, renderModels, SCHEMA_FILE } from './prisma-models-render.js';
import { read, sourceFiles } from './isolation-scan.js';

describe('OpenAPI response models', () => {
  it('prisma-models.ts is up to date with schema.prisma', () => {
    const expected = renderModels(readFileSync(SCHEMA_FILE, 'utf8'));
    const actual = readFileSync(MODELS_FILE, 'utf8').replace(/\r\n/g, '\n');
    // Compared line by line so a failure names the first stale line.
    expect(actual.split('\n')).toEqual(expected.split('\n'));
  });

  it('every exported DTO class has a unique name', () => {
    const files = sourceFiles().filter(
      (f) => f.endsWith('.dto.ts') || f === 'src/common/openapi/prisma-models.ts' || f === 'src/common/openapi/responses.ts',
    );
    expect(files.length).toBeGreaterThan(10);
    const owners = new Map<string, string[]>();
    for (const file of files) {
      for (const match of read(file).matchAll(/^export class (\w+)/gm)) {
        owners.set(match[1], [...(owners.get(match[1]) ?? []), file]);
      }
    }
    const duplicates = [...owners].filter(([, where]) => where.length > 1).map(([name, where]) => `${name}: ${where.join(', ')}`);
    expect(duplicates).toEqual([]);
  });
});
