import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** The pieces of express's request/response this needs. */
interface Req {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(name: string, value: string): void;
  getHeader(name: string): number | string | string[] | undefined;
  removeHeader(name: string): void;
  type(ext: string): unknown;
  sendFile(file: string, options: { root: string; acceptRanges?: boolean }, done?: (err?: unknown) => void): void;
}

/** Adds Accept-Encoding to Vary, keeping what is there (CORS sets `Vary: Origin` earlier). */
function varyOnEncoding(res: Res): void {
  const current = res.getHeader('Vary');
  const fields = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (fields.includes('*') || fields.some((f) => f.toLowerCase() === 'accept-encoding')) return;
  res.setHeader('Vary', [...fields, 'Accept-Encoding'].join(', '));
}

/** Hashed bundles (`assets/<name>-<hash>.js`) never change once built. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Which precompressed siblings (`<file>.br`, `<file>.gz`) exist for one file. */
export interface Variants {
  br: boolean;
  gz: boolean;
}

/**
 * Picks the encoding to send for a request: the highest q-value among the
 * variants that exist, with br winning ties. `identity`, a missing header, or
 * q=0 for every available variant gives null (send the file as it is).
 */
export function pickEncoding(acceptEncoding: string | undefined, available: Variants): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [token = '', ...params] = part.split(';');
    const name = token.trim().toLowerCase();
    if (name === '') continue;
    let quality = 1;
    for (const param of params) {
      const [key = '', value] = param.split('=');
      if (key.trim().toLowerCase() === 'q' && value !== undefined) {
        quality = Number(value.trim());
        if (Number.isNaN(quality)) quality = 0;
      }
    }
    weights.set(name, quality);
  }
  const weightOf = (name: 'br' | 'gzip'): number => weights.get(name) ?? weights.get('*') ?? 0;

  let best: 'br' | 'gzip' | null = null;
  let bestWeight = 0;
  if (available.br && weightOf('br') > 0) {
    best = 'br';
    bestWeight = weightOf('br');
  }
  if (available.gz && weightOf('gzip') > bestWeight) {
    best = 'gzip';
  }
  return best;
}

/**
 * Maps the URL path of every original file that has a `.br` or `.gz` sibling
 * to the variants it has. Built once at startup. Only files found here can be
 * served precompressed, so a request cannot reach anything outside the scan.
 */
function scanPrecompressed(root: string): Map<string, Variants> {
  const originals = new Set<string>();
  const siblings: { original: string; ext: 'br' | 'gz' }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        originals.add(full);
        if (entry.name.endsWith('.br')) siblings.push({ original: full.slice(0, -'.br'.length), ext: 'br' });
        if (entry.name.endsWith('.gz')) siblings.push({ original: full.slice(0, -'.gz'.length), ext: 'gz' });
      }
    }
  };
  walk(root);

  const map = new Map<string, Variants>();
  for (const { original, ext } of siblings) {
    if (!originals.has(original)) continue;
    const key = toUrlPath(root, original);
    const variants = map.get(key) ?? { br: false, gz: false };
    variants[ext] = true;
    map.set(key, variants);
  }
  return map;
}

/** `/assets/x.js` for `<root>/assets/x.js`. */
function toUrlPath(root: string, file: string): string {
  return '/' + path.relative(root, file).split(path.sep).join('/');
}

/** Cache-Control for a file under the web root, by its URL path. */
function cacheControlFor(urlPath: string): string {
  return urlPath.split('/')[1] === 'assets' ? IMMUTABLE : 'no-cache';
}

/**
 * Serves the built web app from the API on the same origin (ADR-010 §2):
 * its files as they are, and index.html for any other page so the browser's
 * router takes over. Never for /api (the API answers, 404 included), for a
 * missing file (a path with an extension gets a 404, not a page), or for
 * anything but GET/HEAD.
 *
 * Files that have a `.br` or `.gz` sibling built next to them (WEB-11) are
 * sent as that variant when the client accepts it, with Content-Encoding and
 * Vary: Accept-Encoding, so the transfer is smaller and no compression runs
 * per request.
 */
export function serveWebApp(app: NestExpressApplication, dir: string): void {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);

  const precompressed = scanPrecompressed(root);

  // Before the static handler, so a precompressed copy is chosen first.
  app.use((req: Req, res: Res, next: (err?: unknown) => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const variants = precompressed.get(req.path);
    if (!variants) return next();
    const raw = req.headers['accept-encoding'];
    const encoding = pickEncoding(Array.isArray(raw) ? raw.join(', ') : raw, variants);
    if (encoding === null) return next();

    varyOnEncoding(res);
    res.setHeader('Content-Encoding', encoding);
    // send() keeps a Content-Type that is already set, so the original's type wins over .br/.gz.
    res.type(path.extname(req.path));
    res.setHeader('Cache-Control', cacheControlFor(req.path));
    // Relative to `root`: send() refuses an absolute path with a dot-directory
    // anywhere in it (e.g. /srv/.apps/web/dist), but only checks the relative part.
    const variant = `${req.path.slice(1)}.${encoding === 'br' ? 'br' : 'gz'}`;
    res.sendFile(variant, { root, acceptRanges: false }, (err) => {
      if (!err) return;
      // Whatever answers the error must not claim a compressed body.
      res.removeHeader('Content-Encoding');
      next(err);
    });
  });

  app.useStaticAssets(root, {
    index: false,
    setHeaders: (res: Res, file: string) => {
      const urlPath = toUrlPath(root, file);
      res.setHeader('Cache-Control', cacheControlFor(urlPath));
      if (precompressed.has(urlPath)) varyOnEncoding(res);
    },
  });

  app.use((req: Req, res: Res, next: () => void) => {
    const api = req.path === '/api' || req.path.startsWith('/api/');
    if ((req.method !== 'GET' && req.method !== 'HEAD') || api || path.extname(req.path) !== '') return next();
    // A new release reaches the browser at once.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root });
  });
}
