// The shared test helpers that tests rely on for their own teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempDir } from './helpers/cleanup.js';

/** A delete that fails with `code` for the first `times` calls. */
function failing(code, times = Infinity) {
  let calls = 0;
  const rm = () => {
    calls += 1;
    if (calls <= times) throw Object.assign(new Error(code), { code });
  };
  return { rm, calls: () => calls };
}

test('removeTempDir removes a directory and ignores one that is already gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-helper-'));
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x');
  removeTempDir(dir);
  assert.equal(existsSync(dir), false);
  removeTempDir(dir);
});

test('a directory still held by an exited process is retried until released', () => {
  const held = failing('EBUSY', 2);
  removeTempDir('x', { rm: held.rm });
  assert.equal(held.calls(), 3);
});

test('a directory that stays held is left with a warning, never failing the test', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const held = failing('EPERM');
  assert.doesNotThrow(() => removeTempDir('x', { rm: held.rm, waitMs: 300 }));
  assert.ok(held.calls() > 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /still held .*EPERM/);
});

test('any other error is still an error', () => {
  const denied = failing('EACCES');
  assert.throws(() => removeTempDir('x', { rm: denied.rm }), /EACCES/);
  assert.equal(denied.calls(), 1);
});
