// @ts-check
// Every Gate 4 scan finding gets an answer.
//
// Before the Gate 4 decision the runner shows each finding of the static scan
// (scripts/gate4-scan.js) and asks the reviewer what it is:
//
//   fixed        the finding is right and the test must change; the gate can
//                then only be rejected (or left undecided), never approved
//   wrong        the finding is a false alarm: the scan misread the test
//   intentional  the finding is right, and the test does it on purpose
//   irrelevant   the finding is right, and it does not matter for this test
//
// On a story that touches a Red-taxonomy domain, "wrong" and "intentional"
// need a short reason. The answers are stored with the decision (context.json
// gate_decisions[].finding_dispositions and the gate record), so metrics can
// tell how often each check is right. An answer never decides the gate, and
// the prompt that asks for it runs only at an interactive terminal, like the
// decision itself.
//
// Pure: no I/O.

/** The answers, in the order the prompt offers them. */
export const DISPOSITIONS = ['fixed', 'wrong', 'intentional', 'irrelevant'];

/** The key the prompt takes for each answer. */
export const DISPOSITION_KEYS = {
  f: 'fixed',
  w: 'wrong',
  i: 'intentional',
  r: 'irrelevant',
};

/**
 * @typedef {{ rule: string, line: number | null, test: string | null,
 *   excerpt: string, note: string }} Finding
 * @typedef {'fixed' | 'wrong' | 'intentional' | 'irrelevant'} Disposition
 * @typedef {{ rule: string, line: number | null, test: string | null,
 *   excerpt: string | null, note: string, disposition: Disposition,
 *   reason: string | null }} DispositionRecord
 */

const EXCERPT_MAX = 200;

/**
 * Which finding an answer is for: the rule, the test, the line and its text,
 * and the note. A test that changes moves or rewrites its lines, so an old
 * answer stops matching instead of covering new code.
 * @param {{ rule: string, line?: number | null, test?: string | null,
 *   excerpt?: string | null, note?: string }} f
 * @returns {string}
 */
export function findingKey(f) {
  return JSON.stringify([
    f.rule,
    f.test ?? null,
    f.line ?? null,
    (f.excerpt ?? '').slice(0, EXCERPT_MAX) || null,
    f.note ?? '',
  ]);
}

/**
 * The answer a typed key or word stands for, or null.
 * @param {string} input what the reviewer typed
 * @returns {Disposition | null}
 */
export function parseAnswer(input) {
  const a = input.trim().toLowerCase();
  const d =
    /** @type {Record<string, string>} */ (DISPOSITION_KEYS)[a] ??
    (DISPOSITIONS.includes(a) ? a : null);
  return /** @type {Disposition | null} */ (d);
}

/**
 * Whether an answer needs a reason.
 * @param {string} disposition
 * @param {boolean} redDomain the story touches a Red-taxonomy domain
 */
export function needsReason(disposition, redDomain) {
  return (
    redDomain && (disposition === 'wrong' || disposition === 'intentional')
  );
}

/**
 * Check the answers and build what is stored. Every finding needs exactly
 * one known answer, and a reason where `needsReason` says so.
 * @param {Finding[]} findings the scan's findings, in order
 * @param {{ disposition: string, reason?: string | null }[]} answers one per finding
 * @param {{ redDomain: boolean }} opts
 * @returns {{ ok: true, dispositions: DispositionRecord[] } |
 *   { ok: false, problems: string[] }}
 */
export function recordDispositions(findings, answers, { redDomain }) {
  /** @type {string[]} */
  const problems = [];
  if (answers.length !== findings.length)
    problems.push(
      `${findings.length} finding(s) but ${answers.length} answer(s)`
    );
  /** @type {DispositionRecord[]} */
  const dispositions = [];
  findings.forEach((f, i) => {
    const a = answers[i];
    if (!a) return;
    const where = `${f.rule}${f.line === null ? '' : `:${f.line}`}`;
    if (!DISPOSITIONS.includes(a.disposition)) {
      problems.push(`${where}: "${a.disposition}" is not an answer`);
      return;
    }
    const reason = (a.reason ?? '').trim() || null;
    if (needsReason(a.disposition, redDomain) && !reason) {
      problems.push(
        `${where}: "${a.disposition}" on a Red-domain story needs a reason`
      );
      return;
    }
    dispositions.push({
      rule: f.rule,
      line: f.line,
      test: f.test,
      excerpt: f.excerpt ? f.excerpt.slice(0, EXCERPT_MAX) : null,
      note: f.note,
      disposition: /** @type {Disposition} */ (a.disposition),
      reason,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, dispositions };
}

/**
 * A finding answered "fixed" means the test changes first, so the reviewed
 * test cannot be approved as it is.
 * @param {DispositionRecord[]} dispositions
 * @returns {boolean}
 */
export function approvalAllowed(dispositions) {
  return !dispositions.some((d) => d.disposition === 'fixed');
}

/**
 * The findings an approved, current Gate 4 decision already answered, other
 * than "fixed": the scan treats them as resolved. Only the latest approval of
 * `code_reviewed` counts, and only while the review gate is still approved.
 * @param {any} context parsed context.json
 * @returns {Set<string>} finding keys
 */
export function answeredFindings(context) {
  const decisions = Array.isArray(context?.gate_decisions)
    ? context.gate_decisions
    : [];
  const last = [...decisions]
    .reverse()
    .find((d) => d?.gate === 'code_reviewed');
  const gate = context?.review_gates?.code_reviewed;
  const approved = gate === true || gate?.status === true;
  if (!last || last.decision !== 'approved' || !approved) return new Set();
  return new Set(
    (last.finding_dispositions ?? [])
      .filter((/** @type {DispositionRecord} */ d) => d.disposition !== 'fixed')
      .map((/** @type {DispositionRecord} */ d) => findingKey(d))
  );
}

/**
 * The gate record's section for the answers.
 * @param {DispositionRecord[]} dispositions
 * @returns {string[]} Markdown lines; none when there is nothing to answer
 */
export function dispositionSection(dispositions) {
  if (!dispositions.length) return [];
  const cell = (/** @type {string} */ s) => s.replace(/\|/g, '\\|');
  return [
    '## Scan findings answered',
    '',
    'Each Gate 4 static scan finding and the reviewer’s answer to it.',
    '',
    '| Finding | Test | Answer | Reason |',
    '| --- | --- | --- | --- |',
    ...dispositions.map(
      (d) =>
        `| ${cell(`[${d.rule}]${d.line === null ? '' : `:${d.line}`}`)} | ${cell(d.test ?? '')} | ${d.disposition} | ${cell(d.reason ?? '')} |`
    ),
    '',
  ];
}

/**
 * Answer rates per check across runs: how often each rule's findings were
 * right. A check's precision is the share of its answered findings that were
 * not "wrong". Within a run, a finding answered at several decisions (a
 * rejection, then a re-review) counts once, with its last answer.
 * @param {any[]} contexts parsed context.json of each run
 * @returns {{ runs_with_dispositions: number, answered: number,
 *   by_rule: Record<string, { fixed: number, wrong: number,
 *     intentional: number, irrelevant: number, total: number,
 *     precision: number | null }> }}
 */
export function dispositionMetrics(contexts) {
  /** @type {Record<string, { fixed: number, wrong: number, intentional: number, irrelevant: number, total: number, precision: number | null }>} */
  const byRule = {};
  let runs = 0;
  let answered = 0;
  for (const ctx of contexts) {
    const events = (
      Array.isArray(ctx?.gate_decisions) ? ctx.gate_decisions : []
    )
      .map((/** @type {any} */ d) => d?.finding_dispositions)
      .filter((/** @type {any} */ x) => Array.isArray(x) && x.length);
    if (!events.length) continue;
    runs += 1;
    /** @type {Map<string, any>} the last answer to each finding */
    const last = new Map();
    for (const list of events)
      for (const d of list)
        if (DISPOSITIONS.includes(d?.disposition)) last.set(findingKey(d), d);
    for (const d of last.values()) {
      const r = (byRule[d.rule] ??= {
        fixed: 0,
        wrong: 0,
        intentional: 0,
        irrelevant: 0,
        total: 0,
        precision: null,
      });
      r[/** @type {Disposition} */ (d.disposition)] += 1;
      r.total += 1;
      answered += 1;
    }
  }
  for (const r of Object.values(byRule))
    r.precision = r.total ? (r.total - r.wrong) / r.total : null;
  return {
    runs_with_dispositions: runs,
    answered,
    by_rule: Object.fromEntries(
      Object.entries(byRule).sort(([a], [b]) => a.localeCompare(b))
    ),
  };
}

/**
 * The metrics Markdown for the answers.
 * @param {ReturnType<typeof dispositionMetrics>} m
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function dispositionLines(m, totalRuns) {
  if (!m.answered)
    return [
      `- No run records an answer to a scan finding yet (${m.runs_with_dispositions}/${totalRuns} run(s)); no check's precision is known.`,
    ];
  const pct = (/** @type {number | null} */ r) =>
    r === null ? 'n/a' : `${Math.round(r * 100)}%`;
  return [
    `- ${m.answered} answer(s) over ${m.runs_with_dispositions}/${totalRuns} run(s). Precision is the share not answered "wrong".`,
    ...Object.entries(m.by_rule).map(
      ([rule, r]) =>
        `- ${rule}: ${r.total} answered, precision ${pct(r.precision)} (fixed ${r.fixed}, wrong ${r.wrong}, intentional ${r.intentional}, irrelevant ${r.irrelevant})`
    ),
  ];
}
