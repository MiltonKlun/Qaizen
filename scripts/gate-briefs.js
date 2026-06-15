// Gate briefs (IMPROVEMENT-PLAN Phase 2, IP-2.2). Pure data + renderer for
// the one-screen brief the runner shows when it halts at a gate. The
// checklist items are taken from docs/review-gates.md (the binding criteria);
// this module only HELPS the reviewer get oriented faster — it never decides
// anything (CLAUDE.md §3.5: the human always decides; assist, never approve).
//
// Renderer contract: renderGateBrief({ step, context, artifacts }) where
// `artifacts` is the CLI-gathered list of the artifacts this gate reviews —
// [{ path, exists, valid }] with valid: true | false | null (null = not a
// JSON artifact / not validated). No I/O here; the CLI gathers, this renders.

import { GATE_KEYS } from './pipeline-state.js';

// Per-gate brief data. `artifacts(ctx)` returns the paths the reviewer reads
// (the things produced since the previous gate); `checklist` is the
// auto-checkable-adjacent criteria summary; `judgment` is what only a human
// can answer (the reason the gate exists).
export const GATE_BRIEFS = {
  gate1: {
    name: 'Gate 1 — Requirement Interpretation',
    artifacts: (ctx) => ['context.json', ctx?.story?.path || 'story.md'],
    checklist: [
      'AC accuracy — every acceptance criterion matches what the story says (no drift, no silent additions)',
      'Ambiguities explicit — everything unclear is in ambiguities[] with the right blocking flag',
      'Risks meaningful — each RISK-XXX is a real product/business/security risk, not a rephrased AC',
      'No invented business rules — everything traces to the story or a labeled ambiguity',
    ],
    judgment: [
      'Would the product owner agree these ACs say what the story means?',
      'Is any "risk" actually decorative — and is any real risk missing?',
    ],
  },
  gate2: {
    name: 'Gate 2 — Test Scope Approval',
    artifacts: (ctx) => [
      ctx?.artifact_paths?.test_cases,
      ctx?.artifact_paths?.planner_brief,
      'context.json',
    ],
    checklist: [
      'Risk coverage — every RISK-XXX is addressed by >=1 TC or explicitly accepted with written justification',
      'Priorities reasonable — P0 only for release-blocking failures; no high-severity risk with only P3 cases',
      'Automation decisions justified — every TC has a real, non-generic automation_decision_reason',
      'Not E2E-heavy — automate_e2e is a deliberate choice per case, not the default',
      'Low-value cases marked manual/skip with a real reason',
      'Out-of-scope discipline — the planner brief explicitly excludes unrelated flows',
    ],
    judgment: [
      'Would you ship on the strength of these cases — is anything important untested?',
      'Are the manual/skip calls genuinely low-value, or convenient?',
    ],
  },
  qa_scope: {
    name: 'QA Scope — Gates 1+2 consolidated (lite track)',
    artifacts: (ctx) => [
      'context.json',
      ctx?.artifact_paths?.test_cases,
      ctx?.artifact_paths?.planner_brief,
    ],
    checklist: [
      'Requirements (Gate 1): ACs match the story, ambiguities explicit, risks meaningful, no invented rules',
      'Scope (Gate 2): every RISK-XXX covered or justified; automation_decision + a real reason on every TC',
      'Lite is justified: this story carries no Red-taxonomy exposure and is genuinely routine (track_floor.minimum is lite)',
      'Not E2E-heavy; low-value cases marked manual/skip with a real reason',
    ],
    judgment: [
      'Are the requirements AND the scope both right — would you sign off on both in one sitting here?',
      'Is lite genuinely appropriate, or is something here consequential enough to deserve the full four gates?',
    ],
  },
  gate3: {
    name: 'Gate 3 — Specs Review',
    artifacts: (ctx) => [
      ctx?.artifact_paths?.playwright_spec,
      ctx?.artifact_paths?.planner_brief,
      ctx?.artifact_paths?.test_cases,
    ],
    checklist: [
      'Matches approved scope — every spec scenario maps to a Gate-2-approved TC (no "while I was in there" additions)',
      'Negative cases present — happy-path-only specs are a rejection',
      'Expected outcomes are business behavior, not implementation detail',
      'No unrelated flows — nothing the brief marked out-of-scope',
      'Traceability — each scenario references its TC-XXX',
    ],
    judgment: [
      'Do the scenarios test what the AC means, or what the app happened to do during exploration?',
      'Is anything covered that was never approved — or approved but missing?',
    ],
  },
  gate4: {
    name: 'Gate 4 — Code Review (PERMANENTLY HUMAN)',
    artifacts: (ctx) => [
      ctx?.artifact_paths?.generated_test,
      ctx?.artifact_paths?.playwright_spec,
      ctx?.artifact_paths?.test_cases,
    ],
    checklist: [
      'Locators stable and robust — most robust option per element (docs/review-gates.md locator policy); no nth-child / generated hashes',
      'Assertions test correct business behavior — what the AC says, not what the page happened to show',
      'No skipped or weakened tests — no .skip/.fixme, no loosened assertions',
      'No hard waits without a written justification',
      'Code readable — a future reader can tell what is exercised',
      'Approved scope covered — every approved automate_e2e TC has a test()',
    ],
    judgment: GATE4_JUDGMENT_QUESTIONS(),
  },
};

// The Gate-4 judgment questions — the things only a human can decide. Exported
// (via the function below) so the pre-Gate-4 scanner (scripts/gate4-scan.js)
// prints the SAME footer it reuses here, no drift. Defined as a function so the
// GATE_BRIEFS literal above can reference it before the const is initialized.
export function GATE4_JUDGMENT_QUESTIONS() {
  return [
    'Would you let this test block a release — do you trust a red AND a green from it?',
    'Does any assertion quietly test less than the TC expected_results?',
  ];
}

function fmtArtifact(a) {
  const exist = a.exists ? 'found' : 'MISSING';
  const valid =
    a.valid === true ? ', schema OK' : a.valid === false ? ', SCHEMA FAIL' : '';
  return `  - ${a.path}  (${exist}${valid})`;
}

/**
 * Render the one-screen brief for a gate step ('gate1'..'gate4').
 * `artifacts`: [{ path, exists, valid }] gathered by the CLI.
 * Returns a string (the CLI prints it).
 */
export function renderGateBrief({ step, context, artifacts = [] }) {
  const brief = GATE_BRIEFS[step];
  if (!brief) throw new Error(`Unknown gate step: ${step}`);
  const gateKey = GATE_KEYS[step];
  const storyId = context?.story?.id || '(unknown story)';

  const autoOk = artifacts.filter((a) => a.exists && a.valid !== false);
  const autoBad = artifacts.filter((a) => !a.exists || a.valid === false);

  const lines = [
    '='.repeat(72),
    `${brief.name}   ·   story ${storyId}   ·   gate key: ${gateKey}`,
    '='.repeat(72),
    '',
    'Artifacts under review (produced since the previous gate):',
    ...artifacts.map(fmtArtifact),
    '',
    'Auto-checks:',
    autoBad.length === 0
      ? '  - all reviewed artifacts exist and schema-validate (where applicable)'
      : `  - ATTENTION: ${autoBad.length} artifact(s) missing or failing validation (listed above)`,
    ...(autoOk.length > 0 && autoBad.length > 0
      ? [`  - ${autoOk.length} artifact(s) OK`]
      : []),
    '',
    'Checklist (docs/review-gates.md — all must hold):',
    ...brief.checklist.map((c) => `  [ ] ${c}`),
    '',
    'Judgment — only you can answer:',
    ...brief.judgment.map((q) => `  ? ${q}`),
    '',
    'Approving records an audit object + a gate_decisions[] event (with',
    'opened_at/decided_at telemetry). Rejecting records the rejection and',
    'stops with the step to redo. The runner never decides for you.',
    '='.repeat(72),
  ];
  return lines.join('\n');
}
