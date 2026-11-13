import { readFile, stat, writeFile } from 'node:fs/promises';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Plugin } from 'vite';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Only text-like assets are worth compressing; html is served by the API without this step. */
const COMPRESSIBLE = /\.(js|mjs|css|svg|json)$/;

/** Below this size the gzip/brotli header overhead outweighs the saving. */
const MIN_BYTES = 1024;

/** A compressed copy is written only when it is at least 10% smaller. */
const MAX_RATIO = 0.9;

/**
 * Writes `.gz` and `.br` copies next to each compressible build asset (ADR-010, WEB-11).
 *
 * The API (`apps/api/src/common/web/serve-web-app.ts`) serves the web build with
 * express static files. When the browser accepts `gzip` or `br`, the API can send
 * these copies with a `Content-Encoding` header instead of compressing on every
 * request, so the bytes on the wire shrink without any runtime CPU cost.
 * Brotli is run at its maximum quality because this work happens once per build.
 */
export function precompress(): Plugin {
  return {
    name: 'erp-precompress',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const dir = outputOptions.dir;
      if (!dir) return;

      const files = Object.keys(bundle).filter((fileName) => COMPRESSIBLE.test(fileName));

      await Promise.all(
        files.map(async (fileName) => {
          const file = path.join(dir, fileName);
          const { size } = await stat(file);
          if (size < MIN_BYTES) return;

          const source = await readFile(file);
          const [gz, br] = await Promise.all([
            gzipAsync(source, { level: 9 }),
            brotliAsync(source, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_SIZE_HINT]: size,
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              },
            }),
          ]);

          await Promise.all([
            gz.length < size * MAX_RATIO ? writeFile(`${file}.gz`, gz) : undefined,
            br.length < size * MAX_RATIO ? writeFile(`${file}.br`, br) : undefined,
          ]);
        }),
      );
    },
  };
}
