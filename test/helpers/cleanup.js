// Removing a test's temporary directory after it ran a real child process.
//
// On Windows, a browser or Playwright worker that has just exited can keep a
// handle on its working directory for several seconds, so deleting the
// directory fails with EBUSY or EPERM. That is the operating system releasing
// the process, not a test result: the test's assertions have already run.
// Retry for a while, then warn and leave the directory (it is gitignored)
// rather than fail a test whose behaviour was verified. Any other error is
// still thrown.

import { rmSync } from 'node:fs';

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const sleep = (/** @type {number} */ ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * @param {string} dir
 * @param {{ waitMs?: number, rm?: (dir: string) => void }} [opts]
 *   `rm` replaces the delete call, for testing this helper
 */
export function removeTempDir(
  dir,
  {
    waitMs = 30000,
    rm = (d) => rmSync(d, { recursive: true, force: true }),
  } = {}
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      rm(dir);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (!TRANSIENT.has(code)) throw e;
      if (Date.now() >= deadline) {
        console.warn(
          `warning: ${dir} is still held by an exited process (${code}); left in place.`
        );
        return;
      }
      sleep(250);
    }
  }
}
