// Tracked files must stand on their own. The maintainer keeps plans, reviews
// and notes locally (gitignored); a public file that names one of them, or
// cites its numbering ("task group 4.3", "IP-2.1"), points readers at a
// document they cannot open. This test lists every such reference.
//
// Exempt: .gitignore (it names local files in order to ignore them), the
// changelog block of an agent or skill (docs/prompt-versioning.md: changelog
// entries are never rewritten, only prepended), and this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

/** References to a local document or to a local plan's numbering. */
const FORBIDDEN = [
  {
    what: 'a local plan, review or notes file',
    re: /\b(?:IMPROVEMENT-PLAN|IMPLEMENTATION_PLAN|PROJECT-BRIEF|CODE_REVIEW|FOLLOWUPS)\b|\b(?:STRATEGY|PLAN|JEV|CLAUDE\.local|AGENTS)\.md\b|\bLEARNING-[\w-]*\.md\b|\bresearch\.local\b|\bdocs\/deferred\.md\b/,
  },
  { what: 'a local plan task group', re: /\b[Tt]ask[ -][Gg]roups? \d/ },
  { what: 'a local plan task id', re: /\b(?:TG ?\d|IP-\d|PFI-\d|T\d\.\d)/ },
  { what: 'a local review finding id', re: /\bfindings? [A-Z]{1,3}-?\d+\b/ },
];

/** Paths that are exempt as a whole. */
const EXEMPT = new Set(['.gitignore', 'test/public-hygiene.test.js']);

/**
 * Line numbers (1-based) of the `changelog:` block in a Markdown file's
 * front matter. The block is a YAML block scalar: indented lines after it.
 * @param {string[]} lines
 * @returns {Set<number>}
 */
export function changelogLines(lines) {
  const skip = new Set();
  if (lines[0]?.trim() !== '---') return skip;
  let inBlock = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (/^changelog:/.test(line)) {
      inBlock = true;
      skip.add(i + 1);
      continue;
    }
    if (inBlock && (line === '' || /^\s/.test(line))) skip.add(i + 1);
    else inBlock = false;
  }
  return skip;
}

/**
 * Every forbidden reference in one file's text.
 * @param {string} path
 * @param {string} text
 * @returns {string[]}
 */
export function planReferences(path, text) {
  if (EXEMPT.has(path)) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const skip = path.endsWith('.md') ? changelogLines(lines) : new Set();
  /** @type {string[]} */
  const found = [];
  lines.forEach((line, i) => {
    if (skip.has(i + 1)) return;
    for (const { what, re } of FORBIDDEN) {
      if (re.test(line)) {
        found.push(`${path}:${i + 1} cites ${what}: ${line.trim()}`);
        break;
      }
    }
  });
  return found;
}

test('a file naming a local plan or its numbering is reported', () => {
  const cases = [
    '// Gate briefs (IMPROVEMENT-PLAN Phase 2).',
    'See IMPLEMENTATION_PLAN.md for the details.',
    'Rebuilt in task group 6.1.',
    '// (Phase 2 TG11; Reporter stage)',
    'Gate briefs (IP-2.2) and the lite track (PFI-1).',
    'archived run (T3.2) is validated too',
    'run-scoped loader (review finding I6).',
    'a stale report (finding I4).',
    'read STRATEGY.md first',
  ];
  for (const line of cases) {
    assert.equal(planReferences('docs/x.md', line).length, 1, line);
  }
});

test('ordinary text, .gitignore and changelog entries are not reported', () => {
  const fine = [
    'The Healer is enforced by code from Phase 3.',
    'An implementation plan for your team is out of scope.',
    'TLS 1.3 and HTTP/2 are required.',
    'Task Group X of Phase Y',
  ];
  for (const line of fine) {
    assert.deepEqual(planReferences('docs/x.md', line), [], line);
  }
  assert.deepEqual(planReferences('.gitignore', '/IMPROVEMENT-PLAN*.md'), []);
  const agent = [
    '---',
    'name: reporter',
    'changelog: |',
    '  - 4.0.0: MAJOR (task group 2.2b).',
    '',
    '  - 3.0.0: from IMPROVEMENT-PLAN-2.',
    'phase_introduced: 1',
    '---',
    'Body text (task group 2.2b).',
  ].join('\n');
  assert.deepEqual(planReferences('agents/reporter.md', agent), [
    'agents/reporter.md:9 cites a local plan task group: Body text (task group 2.2b).',
  ]);
});

/** Every tracked text file, as [path, text]. */
function trackedTexts() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // listed by git but absent from the working tree
    }
    if (!text.includes('\0')) out.push([file, text]); // skip binaries
  }
  return out;
}

test('no tracked file cites a local plan, review or notes file', () => {
  /** @type {string[]} */
  const found = [];
  for (const [file, text] of trackedTexts()) {
    // Schema descriptions are cleaned in their own change (a schema edit is
    // a contract change, CLAUDE.md §3.10); until then they are skipped.
    if (file.startsWith('schemas/')) continue;
    found.push(...planReferences(file, text));
  }
  assert.deepEqual(found, []);
});

// Markdown files that tools generate and git ignores: the story and run
// staging, session notes, metrics and /evolve outputs, and the Playwright
// agents `init-agents` writes. Naming them is how the docs explain the
// workflow.
const RUN_FILES = [
  /(^|\/)story\.md$/,
  /^session-summaries\//,
  /^metrics\//,
  /^evolve\//,
  /^\.claude\/agents\//,
  /^\.qaizen\//,
];

test('no tracked file names a Markdown file that git ignores', () => {
  const texts = trackedTexts().filter(
    ([file]) => !EXEMPT.has(file) && !file.startsWith('schemas/')
  );
  const tracked = new Set(texts.map(([file]) => file));
  /** @type {Map<string, string[]>} */
  const where = new Map();
  const MD = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.md)\b/g;
  for (const [file, text] of texts) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const skip = file.endsWith('.md') ? changelogLines(lines) : new Set();
    lines.forEach((line, i) => {
      if (skip.has(i + 1)) return;
      for (const [, name] of line.matchAll(MD)) {
        if (name.includes('..') || tracked.has(name)) continue;
        if (RUN_FILES.some((re) => re.test(name))) continue;
        const at = where.get(name) ?? [];
        at.push(`${file}:${i + 1}`);
        where.set(name, at);
      }
    });
  }
  // git check-ignore exits 1 when none of the names is ignored.
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: [...where.keys()].join('\n'),
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const ignored = result.stdout.split('\n').filter(Boolean);
  assert.deepEqual(
    ignored.map((name) => `${name} at ${where.get(name)?.join(', ')}`),
    []
  );
});
