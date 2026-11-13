/**
 * Cleanups for a job that is interrupted by a signal (SIGINT / SIGTERM): a
 * backup removes its partial folder, a verify removes its scratch folder with
 * the credentials file in it. Registered while the work runs and removed
 * when it ends normally. SIGKILL and power loss cannot be handled here: the
 * next run's sweep (backup.service.ts) takes those leftovers instead.
 */

interface Entry {
  fn: () => Promise<void> | void;
}

const entries = new Set<Entry>();

/** Registers `fn` to run on an interrupt. Returns the function that unregisters it. */
export function onAbort(fn: () => Promise<void> | void): () => void {
  // An object per registration: the same function registered twice is two entries.
  const entry: Entry = { fn };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** Runs every registered cleanup, in registration order. A failing one does not stop the rest. */
export async function runAbortCleanups(): Promise<void> {
  const pending = [...entries];
  entries.clear();
  for (const entry of pending) {
    try {
      await entry.fn();
    } catch {
      // Best effort: the process is exiting, and the next run's sweep covers what is left.
    }
  }
}
