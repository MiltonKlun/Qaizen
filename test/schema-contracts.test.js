// Every schema's declared contract (scripts/lib/schema-contracts.js) holds
// against the repository, and the Architecture Stability check counts only a
// schema's own companions (task group 10.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import {
  SCHEMA_CONTRACTS,
  BOUNDARIES_DOC,
  missingCompanions,
} from '../scripts/lib/schema-contracts.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const schemas = readdirSync('schemas')
  .filter((f) => f.endsWith('.schema.json'))
  .map((f) => `schemas/${f}`);
const entries = Object.entries(SCHEMA_CONTRACTS);
const read = (/** @type {string} */ p) => JSON.parse(readFileSync(p, 'utf8'));
/** The leading repo path of a producer/consumer entry, if it names one. */
const pathOf = (/** @type {string} */ s) =>
  /^((?:agents|scripts|docs)\/[\w./-]+\.(?:md|js))/.exec(s)?.[1] ?? null;

test('every schema has a contract entry, and every entry a schema', () => {
  assert.deepEqual(
    Object.keys(SCHEMA_CONTRACTS).sort(),
    schemas.sort(),
    'add or remove the entry in scripts/lib/schema-contracts.js'
  );
});

test('every file a contract names exists', () => {
  for (const [schema, c] of entries) {
    const named = [
      ...c.docs,
      ...c.examples,
      ...c.invalid.map((i) => i.path),
      ...[...c.producers, ...c.consumers].map(pathOf).filter((p) => p !== null),
      ...(c.migration.match(/scripts\/migrate-[\w-]+\.js/g) ?? []),
    ];
    for (const p of named)
      assert.ok(existsSync(p), `${schema}: ${p} does not exist`);
  }
});

test('every valid example validates against its schema', () => {
  for (const [schema, c] of entries) {
    for (const p of c.examples) {
      const v = validateValue(read(p), schema);
      assert.equal(v.ok, true, `${p} should be a valid ${schema}`);
    }
  }
});

test('every invalid example is rejected, for the rule it names', () => {
  for (const [schema, c] of entries) {
    assert.ok(c.invalid.length > 0, `${schema} has no invalid example`);
    for (const { path, rule, errorAt } of c.invalid) {
      const v = validateValue(read(path), schema);
      assert.equal(v.ok, false, `${path} must be rejected: ${rule}`);
      const at = (v.ok ? [] : (v.errors ?? [])).map((e) => e.instancePath);
      assert.ok(
        at.includes(errorAt),
        `${path} should fail at "${errorAt}" (${rule}); AJV reported ${JSON.stringify(at)}`
      );
    }
  }
});

test('every schema is discovered by a validator and documented in the boundaries doc', () => {
  const validators =
    readFileSync('scripts/validate-all.js', 'utf8') +
    readFileSync('scripts/validate-examples.js', 'utf8');
  const boundaries = readFileSync(BOUNDARIES_DOC, 'utf8');
  for (const schema of schemas) {
    const name = schema.replace('schemas/', '');
    assert.ok(validators.includes(name), `no validator discovers ${name}`);
    assert.ok(
      boundaries.includes(name),
      `${BOUNDARIES_DOC} does not cover ${name}`
    );
  }
});

test('a schema change is satisfied only by its own companions', () => {
  const schema = 'schemas/test-cases.schema.json';
  // Unrelated agent, doc and example changes do not count.
  const [unrelated] = missingCompanions([
    schema,
    'agents/analyst.md',
    'docs/evidence.md',
    'examples/expected/login-success.expected-context.json',
  ]);
  assert.deepEqual(unrelated.missing, [
    'agents/test-designer.md',
    BOUNDARIES_DOC,
    `one of ${SCHEMA_CONTRACTS[schema].docs.join(', ')}`,
    `one of ${[
      ...SCHEMA_CONTRACTS[schema].examples,
      ...SCHEMA_CONTRACTS[schema].invalid.map((i) => i.path),
    ].join(', ')}`,
  ]);

  // Its own producer, the boundaries doc, one own doc and one own example do.
  const [complete] = missingCompanions([
    schema,
    'agents/test-designer.md',
    BOUNDARIES_DOC,
    'docs/sync-recovery.md',
    'examples/invalid/test-cases.empty-automation-reason.json',
  ]);
  assert.deepEqual(complete.missing, []);
  // Consumer prompts are surfaced for review, never silently dropped.
  assert.deepEqual(complete.review, [
    'agents/api-agent.md',
    'agents/failure-classifier.md',
    'agents/reporter.md',
  ]);
});

test('every producing agent of a schema is required, and a new schema needs an entry', () => {
  const [both] = missingCompanions([
    'schemas/external-execution.schema.json',
    BOUNDARIES_DOC,
    'docs/review-gates.md',
    'examples/expected/login-success.expected-external-plan.json',
  ]);
  assert.deepEqual(both.missing, ['agents/test-designer.md']);

  const [unknown] = missingCompanions(['schemas/new-thing.schema.json']);
  assert.match(
    unknown.missing[0],
    /an entry for schemas\/new-thing\.schema\.json/
  );

  assert.deepEqual(
    missingCompanions(['docs/evidence.md', 'schemas/README.md']),
    []
  );
});
