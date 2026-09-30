// Shared command-line handling: the documented .env subset and strict
// argument parsing (task group 10.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadDotEnv,
  parseCli,
  parseDotEnv,
  parseResolutions,
  validateStoryId,
} from '../scripts/lib/cli.js';

// ------------------------------------------------------------------ .env

test('.env: the documented subset, quoted values and CRLF', () => {
  const text = [
    '# a comment',
    '',
    'JIRA_URL=https://example.atlassian.net',
    'EMPTY=',
    '  SPACED  =  padded value  ',
    'DOUBLE="has # hash and  spaces"',
    "SINGLE='it is=verbatim ${NOT_EXPANDED}'",
    'WITH_COMMENT=secret   # write-capable; put in .env yourself',
    'URL_FRAGMENT=https://x.test/page#section',
    'lower_case=ok',
    'CRLF=line\r',
  ].join('\r\n');
  const { values, invalidLines } = parseDotEnv(text);
  assert.deepEqual(values, {
    JIRA_URL: 'https://example.atlassian.net',
    EMPTY: '',
    SPACED: 'padded value',
    DOUBLE: 'has # hash and  spaces',
    SINGLE: 'it is=verbatim ${NOT_EXPANDED}',
    WITH_COMMENT: 'secret',
    URL_FRAGMENT: 'https://x.test/page#section',
    lower_case: 'ok',
    CRLF: 'line',
  });
  assert.deepEqual(invalidLines, []);
});

test('.env: malformed lines are reported by number and never guessed at', () => {
  const { values, invalidLines } = parseDotEnv(
    [
      'GOOD=1',
      'no equals sign',
      '1BAD=starts with a digit',
      'OPEN="never closed',
      'TRAIL="quoted" junk',
      'export SHELL_STYLE=1',
    ].join('\n')
  );
  assert.deepEqual(values, { GOOD: '1' });
  assert.deepEqual(invalidLines, [2, 3, 4, 5, 6]);
});

test('.env: the process environment always wins, even when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-env-'));
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'A=from-file\nB=from-file\nC=from-file\n');
    /** @type {Record<string, string | undefined>} */
    const env = { A: 'from-env', B: '' };
    const r = loadDotEnv(env, path);
    assert.deepEqual(env, { A: 'from-env', B: '', C: 'from-file' });
    assert.deepEqual(r.loaded, ['C']);
    assert.deepEqual(loadDotEnv({}, join(dir, 'missing.env')), {
      loaded: [],
      invalidLines: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ args

const SPEC = {
  usage: 'Usage: tool <story-id> [options]',
  positionals: [{ name: 'story-id', validate: validateStoryId }],
  options: {
    apply: { type: 'boolean' },
    reconcile: { type: 'boolean' },
    out: { type: 'string' },
    format: { type: 'string', choices: ['markdown', 'csv'] },
    limit: { type: 'integer', min: 1 },
    resolve: { type: 'string', multiple: true },
  },
  exclusive: [['apply', 'reconcile', 'resolve']],
};
const ok = (args) => {
  const r = parseCli(args, SPEC);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r;
};
const fails = (args, pattern) => {
  const r = parseCli(args, SPEC);
  assert.equal(r.ok, false, `${args.join(' ')} should fail`);
  assert.match(r.error, pattern);
};

test('args: options may come before or after the story id, in either form', () => {
  for (const args of [
    ['STORY-1', '--out', 'report.md', '--limit', '3'],
    ['--out', 'report.md', 'STORY-1', '--limit=3'],
    ['--out=report.md', '--limit', '3', 'STORY-1'],
  ]) {
    const r = ok(args);
    assert.equal(r.positionals['story-id'], 'STORY-1');
    assert.equal(r.values.out, 'report.md');
    assert.equal(r.values.limit, 3);
  }
  // The old bug: `--out report.md STORY-1` took report.md as the story.
  assert.equal(
    ok(['--out', 'report.md', 'STORY-1']).positionals['story-id'],
    'STORY-1'
  );
});

test('args: literal values keep spaces and metacharacters', () => {
  const r = ok(['STORY-1', '--out', 'my dir/a&b;$x "q".md']);
  assert.equal(r.values.out, 'my dir/a&b;$x "q".md');
});

test('args: unknown options and missing values are errors', () => {
  fails(['STORY-1', '--aply'], /Unknown option '--aply'/);
  fails(['STORY-1', '--out'], /argument missing/);
  fails(['STORY-1', '--out', '--apply'], /ambiguous|missing/);
  fails(['STORY-1', '--apply=yes'], /does not take an argument/);
});

test('args: a flag given twice, or incompatible flags, are errors', () => {
  fails(
    ['STORY-1', '--out', 'a', '--out', 'b'],
    /--out was given more than once/
  );
  fails(
    ['STORY-1', '--apply', '--reconcile'],
    /--apply and --reconcile cannot be combined/
  );
  fails(['STORY-1', '--apply', '--resolve', 'TC-1=none'], /cannot be combined/);
  // A repeatable option collects every value.
  assert.deepEqual(
    ok(['STORY-1', '--resolve', 'TC-1=none', '--resolve', 'TC-2=QA-9']).values
      .resolve,
    ['TC-1=none', 'TC-2=QA-9']
  );
});

test('args: integers, choices, and positional counts are validated', () => {
  for (const bad of ['0', '-1', '2.5', 'abc', '', '1e3']) {
    fails(
      ['STORY-1', `--limit=${bad}`],
      /--limit expects an integer of at least 1/
    );
  }
  // A negative number after a space reads as an option: still refused.
  fails(['STORY-1', '--limit', '-1'], /ambiguous/);
  fails(
    ['STORY-1', '--format', 'xml'],
    /--format must be one of markdown, csv/
  );
  fails([], /missing <story-id>/);
  fails(['STORY-1', 'STORY-2'], /unexpected argument\(s\): STORY-2/);
});

test('args: a story id must be a safe path component', () => {
  for (const bad of ['../etc', 'a/b', 'a\\b', '.', '..', 'x'.repeat(121)]) {
    fails([bad], /story id/);
  }
  assert.equal(validateStoryId('QA-1042'), null);
});

test('--resolve values: LOCAL-ID=REMOTE-ID or LOCAL-ID=none', () => {
  assert.deepEqual(parseResolutions(['TC-1=none', 'TC-2=QA-9']), [
    { localId: 'TC-1', remote: null },
    { localId: 'TC-2', remote: 'QA-9' },
  ]);
  assert.throws(() => parseResolutions(['TC-1']), /LOCAL-ID=REMOTE-ID/);
});

// ------------------------------------------------------------ a real caller

test('export-to-jira: options before the story id, and a literal path with metacharacters', async () => {
  const { spawnSync } = await import('node:child_process');
  const { cpSync, existsSync, mkdirSync, readFileSync } =
    await import('node:fs');
  const repo = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'qaizen cli & $dir;'));
  try {
    mkdirSync(join(dir, 'test-cases'));
    const tc = JSON.parse(
      readFileSync(
        join(repo, 'examples/expected/login-success.expected-test-cases.json'),
        'utf8'
      )
    );
    writeFileSync(
      join(dir, 'test-cases', `${tc.story_id}.json`),
      JSON.stringify(tc)
    );
    cpSync(join(repo, '.env.example'), join(dir, '.env.example'));
    const out = 'my out & (x);$HOME.md';
    const run = (args) =>
      spawnSync(
        process.execPath,
        [join(repo, 'scripts/export-to-jira.js'), ...args],
        {
          cwd: dir,
          encoding: 'utf8',
        }
      );
    // The old parser took the value of --out as the story id.
    let r = run(['--out', out, '--format', 'csv', tc.story_id]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, out)), 'the literal file name was used');
    assert.match(readFileSync(join(dir, out), 'utf8'), /TC-001/);

    r = run([tc.story_id, '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown option '--bogus'/);
    r = run(['../escape']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /story id may contain only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
