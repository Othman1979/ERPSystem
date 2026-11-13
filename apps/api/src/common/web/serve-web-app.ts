import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** The pieces of express's request/response this needs. */
interface Req {
  method: string;
  path: string;
}
interface Res {
  setHeader(name: string, value: string): void;
  sendFile(file: string): void;
}

/** Hashed bundles (`assets/<name>-<hash>.js`) never change once built. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves the built web app from the API on the same origin (ADR-010 §2):
 * its files as they are, and index.html for any other page so the browser's
 * router takes over. Never for /api (the API answers, 404 included), for a
 * missing file (a path with an extension gets a 404, not a page), or for
 * anything but GET/HEAD.
 */
export function serveWebApp(app: NestExpressApplication, dir: string): void {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);

  app.useStaticAssets(root, {
    index: false,
    setHeaders: (res: Res, file: string) => {
      const inAssets = path.relative(root, file).split(path.sep)[0] === 'assets';
      res.setHeader('Cache-Control', inAssets ? IMMUTABLE : 'no-cache');
    },
  });

  app.use((req: Req, res: Res, next: () => void) => {
    const api = req.path === '/api' || req.path.startsWith('/api/');
    if ((req.method !== 'GET' && req.method !== 'HEAD') || api || path.extname(req.path) !== '') return next();
    // A new release reaches the browser at once.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
