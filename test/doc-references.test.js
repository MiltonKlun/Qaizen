// The tracked docs, agent prompts and skills point only at things that exist
// (task group 10.2): npm scripts, repository files, the options each script
// accepts, and no numbered README sections (the README has none). Archived
// runs under runs/ are history and are not checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * The Markdown files to check: the tracked ones in a git checkout (so the
 * maintainer's gitignored local notes are not checked), or every one on disk
 * in a plain export, which has no local notes. node_modules, dot-directories
 * and runs/ are never checked.
 * @returns {string[]}
 */
function markdownFiles() {
  try {
    return execFileSync('git', ['ls-files', '*.md'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((f) => f && !f.startsWith('runs/'));
  } catch {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {string} */ dir) => {
      for (const e of readdirSync(dir || '.', { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (
            e.name.startsWith('.') ||
            rel === 'node_modules' ||
            rel === 'runs'
          )
            continue;
          walk(rel);
        } else if (e.name.endsWith('.md')) out.push(rel);
      }
    };
    walk('');
    return out.sort();
  }
}

const files = markdownFiles();
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const BUILTIN = new Set(['install', 'ci', 'test']);

/** Every line of every checked file, with its location. */
const lines = files.flatMap((f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .map((text, i) => ({ at: `${f}:${i + 1}`, text }))
);

test('every `npm run <script>` in the docs exists in package.json', () => {
  const bad = [];
  for (const { at, text } of lines) {
    for (const m of text.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
      if (!(m[1] in scripts) && !BUILTIN.has(m[1]))
        bad.push(`${at} npm run ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every repository path the docs name exists', () => {
  const bad = [];
  const PATH =
    // Not nested under another directory: `.claude/agents/...` is generated
    // per machine and gitignored (docs/design-decisions.md D1).
    /(?<![\w./])((?:scripts|schemas|docs|agents|skills|examples|config|test)\/[\w./-]+\.(?:js|mjs|json|md|ts))\b/g;
  for (const { at, text } of lines) {
    for (const m of text.matchAll(PATH)) {
      if (!existsSync(m[1])) bad.push(`${at} ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('no doc points at a numbered README section', () => {
  const bad = lines
    .filter(({ text }) => /README\.md`?\s*(?:section|§)\s*\d/i.test(text))
    .map(({ at }) => at);
  assert.deepEqual(bad, []);
});

test('every option a documented command passes is one its script reads', () => {
  const scriptOf = (/** @type {string} */ name) =>
    /node (scripts\/[\w./-]+\.js)/.exec(scripts[name] ?? '')?.[1] ?? null;
  const source = new Map();
  const bad = [];
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    // A command continued with a trailing backslash is read as one line.
    let { text } = lines[i];
    const { at } = lines[i];
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      text = text.replace(/\\\s*$/, ' ') + lines[++i].text;
    }
    let m = /node (scripts\/[\w./-]+\.js)/.exec(text);
    const script = m
      ? m[1]
      : (m = /npm run ([\w:-]+)/.exec(text)) && scriptOf(m[1]);
    if (!m || !script || !existsSync(script)) continue;
    if (!source.has(script)) source.set(script, readFileSync(script, 'utf8'));
    const src = source.get(script);
    for (const f of text
      .slice(m.index)
      .matchAll(/(?<![\w-])--([a-z][\w-]*)/g)) {
      checked += 1;
      const flag = f[1];
      const known =
        src.includes(`--${flag}`) ||
        src.includes(`'${flag}'`) ||
        src.includes(`"${flag}"`) ||
        new RegExp(`\\b${flag.replace(/-/g, '[-_]?')}\\s*:`).test(src);
      if (!known) bad.push(`${at} ${script} --${flag}`);
    }
  }
  assert.ok(
    checked > 100,
    `only ${checked} documented options were found; the scan is broken`
  );
  assert.deepEqual(bad, []);
});
