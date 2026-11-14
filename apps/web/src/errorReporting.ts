import { ApiError, clientErrorsControllerReport, getAccessToken } from '@erp/api-client';

/** At most this many reports per page load: a loop must not flood the server. */
export const MAX_REPORTS = 5;

/** Browser noise that says nothing about the app. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];

let sent = 0;
const seen = new Set<string>();

/** For tests: forget what was sent. */
export function resetErrorReporting(): void {
  sent = 0;
  seen.clear();
}

function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: 'Error', message: typeof error === 'string' ? error : JSON.stringify(error) ?? String(error) };
}

/**
 * Sends an error caught in the browser to the platform's error monitor
 * (ADR-010 §10.3). Only for a signed-in user (the endpoint needs one; a
 * failed report must not start a sign-in refresh); never for API errors
 * (the server records its own); each kind once per page load, at most
 * MAX_REPORTS. Never throws.
 */
export function reportError(error: unknown): void {
  try {
    if (error instanceof ApiError || !getAccessToken()) return;
    const { name, message, stack } = describe(error);
    if (!message || IGNORED.some((re) => re.test(message))) return;
    const key = `${name}: ${message}`;
    if (seen.has(key) || sent >= MAX_REPORTS) return;
    seen.add(key);
    sent += 1;
    void clientErrorsControllerReport({
      name: name.slice(0, 191),
      message: message.slice(0, 2000),
      ...(stack ? { stack: stack.slice(0, 16000) } : {}),
      page: window.location.pathname.slice(0, 500),
    }).catch(() => undefined);
  } catch {
    // Reporting must never add an error of its own.
  }
}

/** Uncaught errors and unhandled promise rejections of the whole app. */
export function installErrorReporting(): void {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}
