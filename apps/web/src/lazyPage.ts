import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** sessionStorage key: when this tab last reloaded itself for a missing chunk. */
const RELOAD_KEY = 'erp.chunkReloadAt';
/** A second failure within this window is a real error, not a new release. */
const RELOAD_WINDOW_MS = 10_000;

function lastReload(): number | null {
  try {
    const value = window.sessionStorage.getItem(RELOAD_KEY);
    return value ? Number(value) : 0;
  } catch {
    // No storage: never reload, or a broken chunk could reload the page forever.
    return null;
  }
}

function markReload(now: number): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // lastReload() returns null without storage, so we never get here in a loop.
  }
}

/**
 * True when reloading would land on this app again: the browser is online and
 * the server hands out the app's index.html. Offline, or while the proxy
 * answers 502 during a restart, a reload would replace the app with the
 * browser's or the proxy's error page.
 */
export async function appIsServed(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
    return res.ok && (await res.text()).includes('id="root"');
  } catch {
    return false;
  }
}

/**
 * Runs a dynamic import. When it fails (typically: a new release replaced the
 * hashed chunk this tab's old index.html points at), reloads the page once to
 * pick up the new index.html, but only when the app itself is being served
 * (`appIsServed`). Otherwise, or on a second failure soon after, the error is
 * thrown, so the view's error boundary shows it instead of reloading in a loop.
 */
export async function loadWithReload<T>(
  load: () => Promise<T>,
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
  canReload: () => Promise<boolean> = appIsServed,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    const last = lastReload();
    const t = now();
    if (last !== null && t - last > RELOAD_WINDOW_MS && (await canReload())) {
      markReload(t);
      reload();
      // The page is going away; never settle so nothing renders an error meanwhile.
      return new Promise<T>(() => {});
    }
    throw err;
  }
}

/**
 * A route's page as its own chunk (WEB-10):
 * `lazyPage(() => import('./pages/SalesPage').then((m) => m.SalesPage))`.
 * Render it under <Suspense> and an error boundary.
 */
export function lazyPage<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => ({ default: await loadWithReload(load) }));
}
