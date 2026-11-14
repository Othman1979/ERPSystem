import { isLockConflict } from '../shared/document-support.service.js';

/** Tries in all (the first one included). */
export const WRITE_ATTEMPTS = 6;

/**
 * Runs one outbox write again when InnoDB rolled it back as a deadlock victim or
 * a lock wait timed out (P2034, 1213, 1205). Such a statement changed nothing, so
 * running it again is safe; every outbox write is also guarded by the claim token.
 *
 * The write that records a JoFotara answer must not be lost: JoFotara has already
 * answered, and a row left SENDING turns UNKNOWN after ten minutes even when the
 * invoice was accepted. After the last try the original error is thrown, so the
 * caller sees the real cause, not a wrapper.
 *
 * Waits a random 20-100 ms, longer each time, so two workers that collided
 * do not collide again in step. `sleep` is a parameter for the unit test.
 */
export async function retryWrite<T>(
  write: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isLockConflict(err) || attempt >= WRITE_ATTEMPTS) throw err;
      await sleep((20 + Math.floor(Math.random() * 80)) * attempt);
    }
  }
}
