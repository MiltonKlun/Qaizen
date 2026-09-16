// Regression tests for shared artifact I/O (task group 2.1, review finding I6).
//
// The defect this guards: the runner validated context AFTER overwriting the
// file, so a schema-invalid write destroyed the previous valid artifact — and
// "the file exists" was treated as "this run produced valid work", even when
// the file belonged to a different story.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import {
  compileSchema,
  readJson,
  validateValue,
  readValidatedJson,
  writeJsonAtomic,
  loadRunArtifact,
  assertWithinRoot,
  artifactIdentity,
  formatErrors,
  IO_ERROR,
} from '../scripts/lib/artifact-io.js';

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `qaizen-${prefix}-`));
}

// A tiny self-contained schema, so these tests do not depend on the evolving
// pipeline schemas.
function tinySchema(dir) {
  const p = join(dir, 'tiny.schema.json');
  writeFileSync(
    p,
    JSON.stringify({
      type: 'object',
      required: ['story_id', 'value'],
      properties: {
        story_id: { type: 'string' },
        run_id: { type: 'string' },
        value: { type: 'number' },
      },
    })
  );
  return p;
}

// --- failure kinds are distinguished, not collapsed ------------------------

test('readJson distinguishes missing, malformed and valid', () => {
  const dir = scratch('io-read');
  try {
    const missing = readJson(join(dir, 'nope.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, IO_ERROR.MISSING_FILE);

    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{ not json');
    const malformed = readJson(badPath);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.kind, IO_ERROR.MALFORMED_JSON);

    const goodPath = join(dir, 'good.json');
    writeFileSync(goodPath, JSON.stringify({ a: 1 }));
    const good = readJson(goodPath);
    assert.equal(good.ok, true);
    assert.deepEqual(good.data, { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compileSchema reports a missing schema rather than deciding what it means', () => {
  // The two wrappers have opposite policies for an absent schema, so the
  // module must REPORT absence and let each caller decide.
  const res = compileSchema(join(tmpdir(), 'definitely-not-a-schema.json'));
  assert.equal(res.ok, false);
  assert.equal(res.kind, IO_ERROR.MISSING_SCHEMA);
});

test('compileSchema separates an invalid schema from invalid data', () => {
  const dir = scratch('io-schema');
  try {
    const p = join(dir, 'broken.schema.json');
    writeFileSync(p, '{ "type": ');
    const res = compileSchema(p);
    assert.equal(res.ok, false);
    assert.equal(res.kind, IO_ERROR.INVALID_SCHEMA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schemas are cached by resolved path (same compiled validator reused)', () => {
  const dir = scratch('io-cache');
  try {
    const p = tinySchema(dir);
    const a = compileSchema(p);
    const b = compileSchema(join(dir, '.', 'tiny.schema.json'));
    assert.equal(a.ok && b.ok, true);
    assert.equal(
      a.validate,
      b.validate,
      'same resolved path must share one compile'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- diagnostics name fields, never values --------------------------------

test('diagnostics name the field path and never dump the artifact value', () => {
  const dir = scratch('io-diag');
  try {
    const schemaPath = tinySchema(dir);
    const secretish = 'SYNTHETIC-VALUE-do-not-print-me';
    const res = validateValue(
      { story_id: 'S-1', value: secretish },
      schemaPath
    );
    assert.equal(res.ok, false);
    const lines = formatErrors(res.errors).join('\n');
    assert.match(lines, /\/value/, 'should name the offending field path');
    assert.ok(
      !lines.includes(secretish),
      'diagnostics must not echo the artifact value'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the core I6 guarantee: an invalid write never lands ------------------

test('writeJsonAtomic refuses an invalid value and leaves the existing file intact', () => {
  const dir = scratch('io-write');
  try {
    const schemaPath = tinySchema(dir);
    const target = join(dir, 'artifact.json');
    const original = { story_id: 'S-1', value: 1 };
    writeFileSync(target, JSON.stringify(original, null, 2) + '\n');
    const before = readFileSync(target, 'utf8');

    // `value` must be a number; this is schema-invalid.
    const res = writeJsonAtomic(
      target,
      { story_id: 'S-1', value: 'not-a-number' },
      { schemaPath }
    );

    assert.equal(res.ok, false, 'invalid value must be refused');
    assert.equal(res.kind, IO_ERROR.SCHEMA_INVALID_DATA);
    assert.equal(
      readFileSync(target, 'utf8'),
      before,
      'existing destination bytes must survive a rejected write'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic writes a valid value and leaves no temp files behind', () => {
  const dir = scratch('io-write-ok');
  try {
    const schemaPath = tinySchema(dir);
    const target = join(dir, 'artifact.json');
    const res = writeJsonAtomic(
      target,
      { story_id: 'S-1', value: 42 },
      { schemaPath }
    );
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
      story_id: 'S-1',
      value: 42,
    });
    // Only task-owned temp files are created, and none survive.
    const strays = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(
      strays,
      [],
      `temp files left behind: ${strays.join(', ')}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic creates missing parent directories', () => {
  const dir = scratch('io-mkdir');
  try {
    const schemaPath = tinySchema(dir);
    const target = join(dir, 'nested', 'deeper', 'artifact.json');
    const res = writeJsonAtomic(
      target,
      { story_id: 'S-1', value: 7 },
      { schemaPath }
    );
    assert.equal(res.ok, true, res.message);
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic refuses a destination outside the allowed root', () => {
  const dir = scratch('io-root');
  try {
    const root = join(dir, 'workspace');
    mkdirSync(root, { recursive: true });
    const escape = join(root, '..', 'outside.json');
    const res = writeJsonAtomic(
      escape,
      { story_id: 'S-1', value: 1 },
      { root }
    );
    assert.equal(res.ok, false);
    assert.equal(res.kind, IO_ERROR.PATH_ESCAPE);
    assert.equal(existsSync(join(dir, 'outside.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWithinRoot accepts the root itself and paths inside it', () => {
  const dir = scratch('io-root2');
  try {
    assert.equal(assertWithinRoot(join(dir, 'a.json'), dir).ok, true);
    assert.equal(assertWithinRoot(dir, dir).ok, true);
    assert.equal(assertWithinRoot(join(dir, '..', 'b.json'), dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- "the file exists" is not "it belongs to this run" --------------------

test('artifactIdentity reads both the nested and flat identity shapes', () => {
  assert.deepEqual(
    artifactIdentity({ story: { id: 'STORY-1' }, run_id: 'r1' }),
    {
      storyId: 'STORY-1',
      runId: 'r1',
    }
  );
  assert.deepEqual(artifactIdentity({ story_id: 'STORY-2' }), {
    storyId: 'STORY-2',
    runId: null,
  });
});

test('loadRunArtifact refuses an artifact belonging to a different story', () => {
  const dir = scratch('io-identity');
  try {
    const schemaPath = tinySchema(dir);
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({ story_id: 'STORY-OLD', value: 1 }));

    const wrong = loadRunArtifact(p, schemaPath, { storyId: 'STORY-NEW' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.kind, IO_ERROR.IDENTITY_MISMATCH);

    const right = loadRunArtifact(p, schemaPath, { storyId: 'STORY-OLD' });
    assert.equal(right.ok, true, right.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRunArtifact refuses an artifact that carries no identity at all', () => {
  const dir = scratch('io-noid');
  try {
    const schemaPath = join(dir, 'loose.schema.json');
    writeFileSync(schemaPath, JSON.stringify({ type: 'object' }));
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({ value: 1 }));

    const res = loadRunArtifact(p, schemaPath, { storyId: 'STORY-NEW' });
    assert.equal(res.ok, false, 'unconfirmable identity must not pass');
    assert.equal(res.kind, IO_ERROR.IDENTITY_MISMATCH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRunArtifact refuses a mismatched run_id', () => {
  const dir = scratch('io-run');
  try {
    const schemaPath = tinySchema(dir);
    const p = join(dir, 'a.json');
    writeFileSync(
      p,
      JSON.stringify({ story_id: 'S-1', run_id: 'run-a', value: 1 })
    );
    const res = loadRunArtifact(p, schemaPath, {
      storyId: 'S-1',
      runId: 'run-b',
    });
    assert.equal(res.ok, false);
    assert.equal(res.kind, IO_ERROR.IDENTITY_MISMATCH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readValidatedJson reports schema-invalid data distinctly from unreadable', () => {
  const dir = scratch('io-rv');
  try {
    const schemaPath = tinySchema(dir);
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({ story_id: 'S-1' })); // missing `value`
    const res = readValidatedJson(p, schemaPath);
    assert.equal(res.ok, false);
    assert.equal(res.kind, IO_ERROR.SCHEMA_INVALID_DATA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the CLIs keep their contracts ----------------------------------------

function runCli(args) {
  const r = spawnSync(execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('validate-json CLI: schema problems exit 2, data problems exit 1', () => {
  const dir = scratch('io-cli');
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ not: 'a valid context' }));

    // Invalid DATA => 1
    const dataFail = runCli([
      'scripts/validate-json.js',
      'schemas/context.schema.json',
      bad,
    ]);
    assert.equal(dataFail.code, 1, dataFail.out);
    assert.match(dataFail.out, /does NOT validate/);

    // Missing SCHEMA => 2 (a setup problem, not a data verdict)
    const schemaFail = runCli([
      'scripts/validate-json.js',
      'schemas/no-such-schema.json',
      bad,
    ]);
    assert.equal(schemaFail.code, 2, schemaFail.out);

    // Missing DATA file => 2
    const missing = runCli([
      'scripts/validate-json.js',
      'schemas/context.schema.json',
      join(dir, 'absent.json'),
    ]);
    assert.equal(missing.code, 2, missing.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both discovery wrappers still report their historical summaries', () => {
  const examples = runCli(['scripts/validate-examples.js']);
  assert.equal(examples.code, 0, examples.out);
  assert.match(examples.out, /\d+ passed, 0 failed/);

  const all = runCli(['scripts/validate-all.js']);
  assert.equal(all.code, 0, all.out);
  assert.match(all.out, /\d+ passed, 0 failed/);
});
