// Tracked files must stand on their own. The maintainer keeps plans, reviews
// and notes locally (gitignored); a public file that names one of them, or
// cites its numbering ("task group 4.3", "IP-2.1"), points readers at a
// document they cannot open. This test lists every such reference.
//
// Exempt: the patterns in .gitignore (they name local files in order to
// ignore them; its comments are checked), the changelog block of an agent or
// skill (docs/prompt-versioning.md: changelog entries are never rewritten,
// only prepended), and this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, posix } from 'node:path';

/** References to a local document or to a local plan's numbering. */
const FORBIDDEN = [
  {
    what: 'a local plan, review or notes file',
    re: /\b(?:IMPROVEMENT-PLAN|IMPLEMENTATION_PLAN|PROJECT-BRIEF|CODE_REVIEW|FOLLOWUPS)\b|\b(?:STRATEGY|PLAN|JEV|CLAUDE\.local|AGENTS)\.md\b|\bLEARNING-[\w-]*\.md\b|\bresearch\.local\b|\bdocs\/deferred\.md\b/,
  },
  { what: 'a local plan task group', re: /\b[Tt]ask[ -][Gg]roups? \d/ },
  { what: 'a local plan task id', re: /\b(?:TG ?\d|IP-\d|PFI-\d|T\d\.\d)/ },
  { what: 'a local review finding id', re: /\bfindings? [A-Z]\d+\b/ },
  {
    what: 'a local plan phase',
    re: /\bPhase[- ]\d|\bP1\.5\b/,
    // CLAUDE.md states binding rules in terms of the build phases; archived
    // runs and example data are recorded as they were; the Phase 2 runbook is
    // a historical record of that slice.
    except: [
      /^CLAUDE\.md$/,
      /^runs\//,
      /^examples\/(?:stories|expected|invalid|evaluation)\//,
      /^docs\/phase2-vertical-slice-runbook\.md$/,
    ],
  },
];

const SELF = 'test/public-hygiene.test.js';

/** The comment or quote marker a wrapped line starts with. */
const LEAD = /^\s*(?:\/\/|\/?\*+|#|>|-)?\s*/;

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
 * Line numbers (1-based) a file is allowed to keep as they are.
 * @param {string} path
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function exemptLines(path, lines) {
  if (path === '.gitignore') {
    // Patterns name local files; comments must not cite them.
    const skip = new Set();
    lines.forEach((line, i) => {
      if (!line.trimStart().startsWith('#')) skip.add(i + 1);
    });
    return skip;
  }
  return path.endsWith('.md') ? changelogLines(lines) : new Set();
}

/**
 * The first forbidden pattern a piece of text in `path` matches.
 * @param {string} text
 * @param {string} path
 */
const firstMatch = (text, path) =>
  FORBIDDEN.find(
    ({ re, except }) =>
      re.test(text) && !except?.some((allowed) => allowed.test(path))
  );

/**
 * Every forbidden reference in one file's text. A reference split across two
 * lines ("task group" / "4.3") is reported on the line where it starts.
 * @param {string} path
 * @param {string} text
 * @returns {string[]}
 */
export function planReferences(path, text) {
  if (path === SELF) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const skip = exemptLines(path, lines);
  /** @type {string[]} */
  const found = [];
  lines.forEach((line, i) => {
    if (skip.has(i + 1)) return;
    let hit = firstMatch(line, path);
    const next = lines[i + 1];
    if (!hit && next !== undefined && !skip.has(i + 2)) {
      const rest = next.replace(LEAD, '');
      if (!firstMatch(rest, path))
        hit = firstMatch(`${line.trimEnd()} ${rest}`, path);
    }
    if (hit) found.push(`${path}:${i + 1} cites ${hit.what}: ${line.trim()}`);
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
    '// split across lines (task group\n// 4.2), still a pointer',
    '> the protocol (version 2.0, task group\n> 9.2). The protocol',
    'The Healer is enforced by code from Phase 3.',
    'API branch (Phase 1.5+)',
  ];
  for (const text of cases) {
    assert.equal(planReferences('docs/x.md', text).length, 1, text);
  }
  // The build phases stay where they are binding rules or recorded history.
  for (const path of [
    'CLAUDE.md',
    'runs/STORY-001/x/specs/STORY-001.md',
    'examples/stories/login-success.md',
  ]) {
    assert.deepEqual(
      planReferences(path, 'In Phase 3 it is enforced.'),
      [],
      path
    );
  }
  assert.deepEqual(
    planReferences('.gitignore', '# Healer workspace (Phase 3 TG2).\n.x/'),
    [
      '.gitignore:1 cites a local plan task id: # Healer workspace (Phase 3 TG2).',
    ]
  );
});

test('ordinary text, .gitignore patterns and changelog entries are not reported', () => {
  const fine = [
    'The Healer is enforced by code.',
    'An implementation plan for your team is out of scope.',
    'TLS 1.3 and HTTP/2 are required.',
    'Task Group X of Phase Y',
    'a finding CVE-2026-1234 in a dependency',
    'every task group\nof reviewers signs off',
  ];
  for (const text of fine) {
    assert.deepEqual(planReferences('docs/x.md', text), [], text);
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

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Every tracked file path, relative to the repository root. */
const TRACKED = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

/** Every tracked text file, as [path, text]. */
function trackedTexts() {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const file of TRACKED) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
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
  const tracked = new Set(TRACKED);
  /** @type {Map<string, string[]>} */
  const where = new Map();
  const MD = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.md)\b/g;
  for (const [file, text] of trackedTexts()) {
    if (file === SELF) continue;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const skip = exemptLines(file, lines);
    const dir = posix.dirname(file);
    lines.forEach((line, i) => {
      if (skip.has(i + 1)) return;
      for (const [, name] of line.matchAll(MD)) {
        if (name.includes('..')) continue;
        // A name may be written from the repo root or from the file's folder.
        const candidates = [name, posix.join(dir, name)];
        if (candidates.some((c) => tracked.has(c))) continue;
        if (RUN_FILES.some((re) => re.test(name))) continue;
        for (const c of new Set(candidates)) {
          const at = where.get(c) ?? [];
          at.push(`${file}:${i + 1}`);
          where.set(c, at);
        }
      }
    });
  }
  // git check-ignore exits 1 when none of the names is ignored.
  const result = spawnSync(
    'git',
    ['-C', ROOT, 'check-ignore', '--no-index', '--stdin'],
    { input: [...where.keys()].join('\n'), encoding: 'utf8' }
  );
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const ignored = result.stdout.split('\n').filter(Boolean);
  assert.deepEqual(
    ignored.map((name) => `${name} at ${where.get(name)?.join(', ')}`),
    []
  );
});
