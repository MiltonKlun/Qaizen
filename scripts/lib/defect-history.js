// @ts-check
// What past runs found: the defect history the Analyst reads when it scores a
// risk's likelihood (agents/analyst.md, the risk matrix).
//
// Read from the archived runs under runs/<story>/<run>/, the same archives
// npm run metrics reads, and never from anything else: no database. A demo
// run (its DEMO_RUN sentinel) is skipped. A partial archive without a
// failure analysis is counted as read, with nothing found. Product bugs are
// the defects; other failure classes (a flaky test, the environment) are
// counted per run, because they say something about the area, not about the
// product. The output carries no generation time, so the same archives give
// the same file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One product bug a past run found.
 * @typedef {{ story: string, run: string, failure: string,
 *   bug: string | null, jira: string | null, testCase: string | null,
 *   risks: { id: string, description: string, severity: string }[],
 *   summary: string }} PastBug
 * @typedef {{ story: string, run: string, analysed: boolean,
 *   others: Record<string, number> }} PastRun
 */

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} path */
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

/**
 * The summary line and Jira key of a bug draft (docs/bug-draft-format.md).
 * @param {string} path
 * @returns {{ summary: string | null, jira: string | null }}
 */
function draftFacts(path) {
  if (!existsSync(path)) return { summary: null, jira: null };
  const md = readFileSync(path, 'utf8');
  const section = (/** @type {string} */ name) =>
    new RegExp(`## ${name}\\s*\\n+([^\\n#][^\\n]*)`).exec(md)?.[1]?.trim() ??
    null;
  const jira = section('Jira Issue Key');
  return {
    summary: section('Summary'),
    jira: jira && /^[A-Z][A-Z0-9_]*-\d+$/.test(jira) ? jira : null,
  };
}

/**
 * Every archived run, oldest story and run first, with what it found.
 * @param {string} runsDir
 * @returns {{ runs: PastRun[], bugs: PastBug[] }}
 */
export function collectDefects(runsDir) {
  /** @type {PastRun[]} */
  const runs = [];
  /** @type {PastBug[]} */
  const bugs = [];
  if (!isDir(runsDir)) return { runs, bugs };
  for (const story of readdirSync(runsDir).sort()) {
    const storyDir = join(runsDir, story);
    if (!isDir(storyDir)) continue;
    for (const run of readdirSync(storyDir).sort()) {
      const dir = join(storyDir, run);
      if (!isDir(dir) || existsSync(join(dir, 'DEMO_RUN'))) continue;
      const ctx = readJson(join(dir, 'context.json'));
      const analysis = readJson(join(dir, 'analysis', 'failure-analysis.json'));
      /** @type {Record<string, number>} */
      const others = {};
      runs.push({ story, run, analysed: Boolean(analysis), others });
      if (!analysis) continue;
      const casesRel =
        ctx?.artifact_paths?.test_cases || `test-cases/${story}.json`;
      /** @type {{ test_case_id: string, risk_ids?: string[] }[]} */
      const cases = readJson(join(dir, casesRel))?.test_cases ?? [];
      /** @type {{ risk_id: string, description: string, severity: string }[]} */
      const risks = ctx?.risks ?? [];
      /** @type {{ failure_id: string, classification: string, test_case_id?: string | null, bug_draft_path?: string, classification_reason?: string, error_message?: string }[]} */
      const failures = analysis.failures ?? [];
      for (const f of failures) {
        if (f.classification !== 'product_bug') {
          others[f.classification] = (others[f.classification] ?? 0) + 1;
          continue;
        }
        const riskIds =
          cases.find((c) => c.test_case_id === f.test_case_id)?.risk_ids ?? [];
        const draft = f.bug_draft_path
          ? draftFacts(join(dir, f.bug_draft_path))
          : { summary: null, jira: null };
        bugs.push({
          story,
          run,
          failure: f.failure_id,
          bug: f.bug_draft_path?.match(/BUG-\d+/)?.[0] ?? null,
          jira: draft.jira,
          testCase: f.test_case_id ?? null,
          risks: riskIds.map((id) => {
            const r = risks.find((x) => x.risk_id === id);
            return {
              id,
              description: r?.description ?? '(not in the archived context)',
              severity: r?.severity ?? '?',
            };
          }),
          summary: (
            draft.summary ??
            f.classification_reason ??
            f.error_message ??
            ''
          )
            .replace(/\s+/g, ' ')
            .trim(),
        });
      }
    }
  }
  return { runs, bugs };
}

const cell = (/** @type {string} */ s) => s.replace(/\|/g, '\\|');

/**
 * The digest the Analyst reads.
 * @param {{ runs: PastRun[], bugs: PastBug[] }} history
 * @returns {string}
 */
export function renderDefectHistory({ runs, bugs }) {
  const analysed = runs.filter((r) => r.analysed).length;
  const lines = [
    '# Defect history',
    '',
    'Built by `npm run defect-history` from the archived runs in `runs/` (demo',
    'runs excluded); regenerate it rather than editing it. The Analyst reads it',
    'to ground the likelihood of a risk in evidence (agents/analyst.md): a past',
    'product bug in the same area raises likelihood, and is cited in',
    '`likelihood_basis` by its story and bug id. No entry here is a reason to',
    'lower a likelihood the change itself raises.',
    '',
    `Runs read: ${runs.length} · with a failure analysis: ${analysed} · product bugs: ${bugs.length}`,
    '',
    '## Product bugs',
    '',
  ];
  if (!bugs.length) {
    lines.push('No product bug is recorded in the archived runs yet.', '');
  } else {
    lines.push(
      '| Story | Run | Failure | Bug | Test case | Risk at the time | What failed |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...bugs.map((b) =>
        [
          b.story,
          b.run,
          b.failure,
          b.jira ? `${b.bug ?? '?'} (${b.jira})` : (b.bug ?? '(no draft)'),
          b.testCase ?? '(unlinked)',
          b.risks.length
            ? b.risks
                .map((r) => `${r.id} (${r.severity}): ${r.description}`)
                .join('<br>')
            : '(no risk linked)',
          b.summary || '(no summary)',
        ]
          .map((c) => cell(String(c)))
          .join(' | ')
          .replace(/^/, '| ')
          .concat(' |')
      ),
      ''
    );
  }
  lines.push(
    '## Other failures, by run',
    '',
    '| Story | Run | Failures that were not product bugs |',
    '| --- | --- | --- |',
    ...runs.map((r) => {
      const found = Object.entries(r.others)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      return `| ${r.story} | ${r.run} | ${r.analysed ? found || 'none' : 'no failure analysis archived'} |`;
    }),
    ''
  );
  return lines.join('\n');
}
