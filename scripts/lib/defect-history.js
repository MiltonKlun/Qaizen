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
// product. Escaped defects, bugs a completed run should have caught and did
// not, come from outcomes/escaped-defects/ (scripts/record-outcome.js), with
// the risks they fall under read from the run they name. The output carries
// no generation time, so the same records give the same file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ESCAPED_DIR, readEscapedDefects } from './outcomes.js';

/**
 * One product bug a past run found.
 * @typedef {{ story: string, run: string, failure: string,
 *   bug: string | null, jira: string | null, testCase: string | null,
 *   risks: { id: string, description: string, severity: string }[],
 *   summary: string }} PastBug
 * @typedef {{ story: string, run: string, analysed: boolean,
 *   others: Record<string, number> }} PastRun
 * A product bug a completed run should have caught, found later.
 * @typedef {{ id: string, story: string, run: string,
 *   risks: { id: string, description: string, severity: string }[],
 *   unresolved: string | null, testCases: string[], severity: string,
 *   whyMissed: string, foundIn: string, foundAt: string,
 *   jira: string | null, summary: string }} EscapedBug
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
 * Every archived run, oldest story and run first, with what it found, and
 * every escaped defect recorded against one.
 * @param {string} runsDir
 * @param {string} [escapedDir] where the escaped-defect records are
 * @returns {{ runs: PastRun[], bugs: PastBug[], escaped: EscapedBug[], invalidEscaped: number }}
 */
export function collectDefects(runsDir, escapedDir = ESCAPED_DIR) {
  const { escaped, invalidEscaped } = collectEscaped(runsDir, escapedDir);
  /** @type {PastRun[]} */
  const runs = [];
  /** @type {PastBug[]} */
  const bugs = [];
  if (!isDir(runsDir)) return { runs, bugs, escaped, invalidEscaped };
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
  return { runs, bugs, escaped, invalidEscaped };
}

/**
 * The escaped defects, each with the risks it falls under as the archived
 * run it names describes them.
 * @param {string} runsDir
 * @param {string} escapedDir
 * @returns {{ escaped: EscapedBug[], invalidEscaped: number }}
 */
function collectEscaped(runsDir, escapedDir) {
  const { records, invalid } = readEscapedDefects(escapedDir);
  const escaped = records
    .sort((a, b) => a.escaped_defect_id.localeCompare(b.escaped_defect_id))
    .map((r) => {
      const ctx = readJson(
        join(runsDir, r.story_id, basename(r.run_archive), 'context.json')
      );
      /** @type {{ risk_id: string, description: string, severity: string }[]} */
      const risks = Array.isArray(ctx?.risks) ? ctx.risks : [];
      return {
        id: r.escaped_defect_id,
        story: r.story_id,
        run: r.run_id,
        risks: r.risk_ids.map((/** @type {string} */ id) => {
          const risk = risks.find((x) => x.risk_id === id);
          return {
            id,
            description: risk?.description ?? '(not in the archived context)',
            severity: risk?.severity ?? '?',
          };
        }),
        unresolved: r.traceability_unresolved ?? null,
        testCases: r.test_case_ids,
        severity: r.severity,
        whyMissed: r.why_missed,
        foundIn: r.found_in,
        foundAt: r.found_at,
        jira: r.jira_key ?? null,
        summary: String(r.summary).replace(/\s+/g, ' ').trim(),
      };
    });
  return { escaped, invalidEscaped: invalid };
}

const cell = (/** @type {string} */ s) => s.replace(/\|/g, '\\|');

/**
 * The digest the Analyst reads.
 * @param {{ runs: PastRun[], bugs: PastBug[], escaped?: EscapedBug[], invalidEscaped?: number }} history
 * @returns {string}
 */
export function renderDefectHistory({
  runs,
  bugs,
  escaped = [],
  invalidEscaped = 0,
}) {
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
    'An escaped defect is a product bug a completed run should have caught and',
    'did not, found later and recorded with `npm run record-outcome`. It is a',
    'past product bug like the others, cited by its story and ESC id, and it',
    "also says the run's tests missed that area.",
    '',
    `Runs read: ${runs.length} · with a failure analysis: ${analysed} · product bugs: ${bugs.length} · escaped defects: ${escaped.length}`,
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
  lines.push('## Escaped defects', '');
  if (!escaped.length) {
    lines.push('No escaped defect is recorded yet.', '');
  } else {
    lines.push(
      '| Story | Run | Defect | Risk at the time | Why missed | Found | What happened |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...escaped.map((e) =>
        [
          e.story,
          e.run,
          e.jira ? `${e.id} (${e.jira})` : e.id,
          e.risks.length
            ? e.risks
                .map((r) => `${r.id} (${r.severity}): ${r.description}`)
                .join('<br>')
            : `(no risk: ${e.unresolved ?? 'unresolved'})`,
          e.testCases.length
            ? `${e.whyMissed} (${e.testCases.join(', ')})`
            : e.whyMissed,
          `${e.foundIn}, ${e.foundAt}`,
          `${e.severity}: ${e.summary}`,
        ]
          .map((c) => cell(String(c)))
          .join(' | ')
          .replace(/^/, '| ')
          .concat(' |')
      ),
      ''
    );
  }
  if (invalidEscaped)
    lines.push(
      `${invalidEscaped} escaped-defect record(s) left out: they do not validate against schemas/escaped-defect.schema.json.`,
      ''
    );
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
