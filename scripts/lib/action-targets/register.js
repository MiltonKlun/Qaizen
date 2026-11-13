// @ts-check
// Preloaded into a Playwright run (NODE_OPTIONS=--import, set by
// scripts/lib/action-targets.js) to record what each action of a test acts
// on. It only registers the resolve hook (hooks.js), which hands every test
// file the shim (shim.js) in place of @playwright/test. Never loaded by the
// counted runs of the repeat check or the healer: only by their one extra
// recording run, so the extra work it does cannot change a verdict.

import { register } from 'node:module';

register('./hooks.js', import.meta.url);
