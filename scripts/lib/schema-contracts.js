// @ts-check
// The contract behind every JSON Schema, declared once (task group 10.2).
//
// CLAUDE.md §3.10 (the Architecture Stability Rule) says a schema change moves
// with the agent prompts that produce or consume the artifact, its docs, its
// examples and, when old artifacts must stay valid, a migration script.
// check-contract-changes.js used to accept ANY change under agents/, docs/ or
// examples/expected/ as that companion, so an unrelated doc edit satisfied a
// missing consumer update. This registry names, per schema, the exact files
// that make up its contract; the check and test/schema-contracts.test.js read
// it, and the test fails when a schema is added without an entry or an entry
// points at a file that does not exist.
//
// Pure data plus one pure function; no I/O.

/**
 * @typedef {{ path: string, rule: string, errorAt: string }} InvalidExample
 *   `errorAt` is the instancePath AJV reports for the broken rule.
 * @typedef {{
 *   artifact: string,
 *   producers: string[],
 *   consumers: string[],
 *   docs: string[],
 *   examples: string[],
 *   invalid: InvalidExample[],
 *   discovery: string,
 *   migration: string,
 * }} SchemaContract
 *
 * `producers` / `consumers` name agent prompts (agents/*.md), scripts, or the
 * human step that writes or reads the artifact. Every `agents/*.md` producer
 * is a REQUIRED companion of a schema change; consumers are listed for review.
 * `docs` are the docs that describe the contract (one must change with the
 * schema, besides docs/artifact-boundaries.md). `examples` are valid
 * instances (one must change); `invalid` are instances it must reject.
 */

/** Always a companion of a schema change (CLAUDE.md §3.10, item 2). */
export const BOUNDARIES_DOC = 'docs/artifact-boundaries.md';

/** @type {Record<string, SchemaContract>} */
export const SCHEMA_CONTRACTS = {
  'schemas/benchmark-record.schema.json': {
    artifact: 'evidence/benchmark.jsonl (one record per line)',
    producers: ['scripts/benchmark-capture.js (run by the human operator)'],
    consumers: ['docs/evidence.md (read by people)'],
    docs: ['docs/benchmark-protocol.md', 'docs/benchmark-series-checklist.md'],
    examples: [
      'examples/expected/sample.expected-benchmark-record.json',
      'examples/expected/series.expected-benchmark-record.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/benchmark-record.missing-provenance.json',
        rule: 'a 1.1 record carries its provenance',
        errorAt: '',
      },
    ],
    discovery:
      'validate:examples; each record is validated when benchmark-capture.js appends it, and the smoke tests validate every committed line',
    migration:
      'Additive: 1.0 records stay valid as captured; 1.1 adds provenance and timing.',
  },
  'schemas/context.schema.json': {
    artifact: 'context.json',
    producers: [
      'agents/analyst.md',
      'scripts/run-pipeline.js (gate decisions, bindings, status)',
    ],
    consumers: [
      'every agent',
      'scripts/run-pipeline.js',
      'scripts/lib/approval-binding.js',
    ],
    docs: ['docs/context-json-guide.md', 'docs/review-gates.md'],
    examples: ['examples/expected/login-success.expected-context.json'],
    invalid: [
      {
        path: 'examples/invalid/context.unknown-risk-severity.json',
        rule: 'risk severity is low, medium or high',
        errorAt: '/risks/0/severity',
      },
    ],
    discovery:
      'validate:all (context.json and archived runs); validate:examples',
    migration:
      'scripts/migrate-context-v1-to-v2.js (boolean gates to audit objects) and scripts/migrate-context-gate-decisions.js, both run by npm run migrate for the active run; later fields are optional. No migration binds an approval.',
  },
  'schemas/evaluation-manifest.schema.json': {
    artifact: 'examples/evaluation/manifest.json',
    producers: ['the human team'],
    consumers: ['scripts/evaluate-agents.js'],
    docs: ['docs/prompt-versioning.md'],
    examples: ['examples/evaluation/manifest.json'],
    invalid: [
      {
        path: 'examples/invalid/evaluation-manifest.unknown-expected-stage.json',
        rule: 'a story declares designer, analyst or none',
        errorAt: '/stories/0/expected',
      },
    ],
    discovery: 'validate:all',
    migration: 'Single version (1.0).',
  },
  'schemas/execution-ledger.schema.json': {
    artifact: 'analysis/execution-ledger.json',
    producers: ['scripts/normalize-results.js'],
    consumers: [
      'agents/failure-classifier.md',
      'agents/reporter.md',
      'scripts/run-failure-classifier.js',
      'scripts/run-healer.js',
      'scripts/sync-testlink-execution.js',
    ],
    docs: ['docs/execution-normalization.md'],
    examples: ['examples/expected/mixed-run.expected-execution-ledger.json'],
    invalid: [
      {
        path: 'examples/invalid/execution-ledger.unknown-unit-outcome.json',
        rule: 'a unit outcome is one of the ledger vocabulary',
        errorAt: '/units/0/outcome',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration: 'Single version (1.0); a ledger is rebuilt, never migrated.',
  },
  'schemas/external-execution.schema.json': {
    artifact:
      'planner-input/[story].external-plan.json, external-evidence/[story].results.json, and the --from import document',
    producers: ['agents/test-designer.md', 'scripts/import-execution.js'],
    consumers: [
      'scripts/run-pipeline.js (external gates)',
      'scripts/normalize-results.js',
    ],
    docs: ['docs/review-gates.md', 'docs/pipeline-architecture.md'],
    examples: [
      'examples/expected/login-success.expected-external-plan.json',
      'examples/expected/login-success.expected-external-results.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/external-execution.result-without-operator.json',
        rule: 'every recorded result names its operator',
        errorAt: '/results/0',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration: 'Single version (1.0).',
  },
  'schemas/failure-analysis.schema.json': {
    artifact: 'analysis/failure-analysis.json',
    producers: [
      'scripts/run-failure-classifier.js (the draft)',
      'agents/failure-classifier.md (finalizes it)',
    ],
    consumers: [
      'agents/reporter.md',
      'scripts/run-healer.js',
      'scripts/sync-testlink-execution.js',
      'scripts/pipeline-metrics.js',
    ],
    docs: [
      'docs/healer-guardrails.md',
      'docs/standalone-failure-classifier.md',
    ],
    examples: [
      'examples/expected/classification-evidence.expected-failure-analysis.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/failure-analysis.finalized-red-without-bug-draft.json',
        rule: 'a finalized Red failure names its bug draft',
        errorAt: '/failures/1',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration:
      'Versioned in place: 2.x is derived from the ledger; 1.x analyses in runs/ stay valid under their original rules.',
  },
  'schemas/healer-validation.schema.json': {
    artifact: 'analysis/healer-validation/FAIL-XXX.attempt-N.json',
    producers: ['scripts/run-healer.js'],
    consumers: ['scripts/pipeline-metrics.js', 'the human reviewing a patch'],
    docs: ['docs/healer-guardrails.md', 'docs/standalone-healer.md'],
    examples: [
      'examples/expected/locator-repair.expected-healer-validation.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/healer-validation.healer-outcome-approved.json',
        rule: 'a healer record never claims an approval',
        errorAt: '/outcome',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration: 'Single version (1.0); older Markdown notes are counted apart.',
  },
  'schemas/postman-collection.schema.json': {
    artifact: 'api-tests/collections/[story].postman_collection.json',
    producers: ['agents/api-agent.md'],
    consumers: [
      'scripts/run-newman.js',
      "scripts/run-pipeline.js (Gates 3' and 4')",
    ],
    docs: ['docs/postman-integration.md'],
    examples: ['examples/expected/api-create-user.expected-collection.json'],
    invalid: [
      {
        path: 'examples/invalid/postman-collection.missing-info.json',
        rule: 'a collection carries its info block',
        errorAt: '',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration: 'Postman Collection v2.1 subset; no local versions.',
  },
  'schemas/release-report.schema.json': {
    artifact: 'release/release-report.json',
    producers: ['agents/reporter.md'],
    consumers: [
      'scripts/run-pipeline.js (completion check; a 2.0 report must match the ledger)',
      'scripts/pipeline-metrics.js',
      'release reviewers',
    ],
    docs: [
      'docs/execution-normalization.md',
      'docs/pipeline-architecture.md',
      'docs/traceability.md',
    ],
    examples: [
      'examples/expected/mixed-run.expected-release-report.json',
      'examples/expected/api-create-user.expected-release-report.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/release-report.unknown-recommendation.json',
        rule: 'the recommendation is pass, fail, conditional_pass or blocked',
        errorAt: '/release_recommendation',
      },
      {
        path: 'examples/invalid/release-report.v2-counts-without-breakdown.json',
        rule: 'a 2.x report explains every count block with its outcome breakdown',
        errorAt: '/execution_summary/e2e',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration:
      '2.0 (task group 2.2b) is written for a 2.x failure analysis, with ledger-derived counts; 1.x reports keep their meaning and are never reinterpreted. scripts/migrate-release-report-tg12.js adds the optional rollups to older 1.x reports.',
  },
  'schemas/spec-review.schema.json': {
    artifact: 'analysis/spec-reviews/[story].spec-review.json',
    producers: ['agents/spec-reviewer.md'],
    consumers: ['the human at Gate 3'],
    docs: ['docs/review-gates.md'],
    examples: [
      'examples/expected/spec-review-uncovered.expected-spec-review.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/spec-review.eligible-with-uncovered-high-risk.json',
        rule: 'an uncovered high-severity risk makes auto_approval_eligible false',
        errorAt: '/auto_approval_eligible',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration:
      'Single version (1.0); the auto_approval_eligible rule (task group 10.2) was already in the prompt, and every archived review satisfies it.',
  },
  'schemas/test-cases.schema.json': {
    artifact: 'test-cases/[story].json',
    producers: [
      'agents/test-designer.md',
      'scripts/sync-to-testlink.js and scripts/create-jira-testcases.js (linkage fields only)',
    ],
    consumers: [
      'agents/api-agent.md',
      'agents/failure-classifier.md',
      'agents/reporter.md',
      'scripts/normalize-results.js (approved scope)',
      'scripts/run-pipeline.js',
    ],
    docs: [
      'docs/automation-decision-model.md',
      'docs/standalone-test-designer.md',
      'docs/sync-recovery.md',
    ],
    examples: [
      'examples/expected/login-success.expected-test-cases.json',
      'examples/expected/sync-recovery.expected-test-cases.json',
    ],
    invalid: [
      {
        path: 'examples/invalid/test-cases.empty-automation-reason.json',
        rule: 'every automation decision states its reason',
        errorAt: '/test_cases/0/automation_decision_reason',
      },
    ],
    discovery: 'validate:all; validate:examples',
    migration:
      'scripts/migrate-testcases-external-ids.js (optional: mirrors testlink_id into external_ids); the legacy field stays valid.',
  },
};

/** The `agents/*.md` paths named in a producer list. */
const agentPaths = (/** @type {string[]} */ list) =>
  list.filter((p) => /^agents\/[^ ]+\.md$/.test(p));

/**
 * Which companion files a schema change is missing.
 *
 * For each changed schema: every agent prompt that PRODUCES the artifact,
 * docs/artifact-boundaries.md, one of its own docs, and one of its own
 * examples must change too. A file belonging to another contract never
 * counts. Consumer prompts are returned as `review` (they may need a change,
 * depending on which field moved).
 *
 * @param {string[]} changed repo-relative paths, forward slashes
 * @param {Record<string, SchemaContract>} [contracts]
 * @returns {{ schema: string, missing: string[], review: string[] }[]}
 */
export function missingCompanions(changed, contracts = SCHEMA_CONTRACTS) {
  const has = new Set(changed);
  const any = (/** @type {string[]} */ paths) => paths.some((p) => has.has(p));
  return changed
    .filter((f) => f.startsWith('schemas/') && f.endsWith('.schema.json'))
    .map((schema) => {
      const c = contracts[schema];
      if (!c) {
        return {
          schema,
          missing: [
            `an entry for ${schema} in scripts/lib/schema-contracts.js`,
          ],
          review: [],
        };
      }
      const missing = agentPaths(c.producers).filter((p) => !has.has(p));
      if (!has.has(BOUNDARIES_DOC)) missing.push(BOUNDARIES_DOC);
      if (!any(c.docs)) missing.push(`one of ${c.docs.join(', ')}`);
      const examples = [...c.examples, ...c.invalid.map((i) => i.path)];
      if (!any(examples)) missing.push(`one of ${examples.join(', ')}`);
      const review = agentPaths(c.consumers).filter((p) => !has.has(p));
      return { schema, missing, review };
    });
}
