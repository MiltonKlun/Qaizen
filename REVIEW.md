# How to review a change to Qaizen

This file tells reviewers, human or AI (`/code-review`, `/security-review`), what failure looks like in this repository. Read `CLAUDE.md` first: its rules are what a change must not break. An AI review is advisory, and an AI approval never counts as a human approval.

## What failure looks like here

1. **A contract changed without its consumers.** A change to `schemas/*.schema.json` must land in the same change as every agent prompt that produces or consumes the artifact, `docs/artifact-boundaries.md`, `docs/pipeline-architecture.md` when the change is structural, the affected `examples/expected/` files, and a `scripts/migrate-*.js` when old artifacts must stay valid.
2. **A prompt contract changed without its examples.** An agent prompt version bump that changes what the agent produces must update the demo fixtures and `examples/expected/` files that model that output, and a MAJOR bump must carry its candidate evaluation (`docs/prompt-versioning.md`). Evidence that cannot live in git, such as an evaluation result, belongs on the pull request; a reviewer without access to it says so instead of assuming it exists.
3. **A path to approve a gate without a person.** Any flag, environment variable, script or default that records, pre-decides or bypasses a gate decision, or that drops a reviewed input from an approval digest.
4. **A weakened safety check.** The healer guardrails accepting more edits, the failure classifier granting Green more easily, the Gate 4 scan, gate briefs or release rules accepting more, or validation becoming optional. Each such change needs a test proving the cases it used to refuse are still refused.
5. **A write across folder ownership** (`docs/artifact-boundaries.md`), or an agent writing where its prompt says it must not.
6. **Faked or dropped traceability links.** An unprovable link must say `traceability_unresolved` with a reason.
7. **Secrets.** Credentials or tokens in code, examples, fixtures, logs or published reports; any code that reads or prints `.env` values (`docs/secrets-management.md`).
8. **External writes** to Jira, TestLink or other services outside the deterministic scripts that require an explicit `--apply`.
9. **An unlisted or unpinned dependency.** A new npm package, MCP server, Docker image or GitHub Action not allowed by `CLAUDE.md`, or one added without a pinned version (`docs/dependency-maintenance.md`).
10. **Docs that promise what the code does not do**, or code that silently changes documented behavior.
11. **References to files that are not in the repository**, such as local plans, reviews or notes, and any AI-attribution text.
12. **A changed README tagline.**
13. **Code dropped by a merge-conflict resolution.** Compare each resolved file against both parents.
14. **Tests weakened instead of fixed.** Behavior changed without a test, a test skipped, deleted or loosened, or a test that depends on timing.

## Skip

- `runs/`: archived runs are byte-exact evidence.
- `examples/evaluation/reporter-inputs/`: their gate bindings are digests of these exact bytes.
- `package-lock.json`: review `package.json` and the dependency docs instead.
- Formatting and lint style: Prettier and ESLint already check them.

## How to report

- Give a file and line as evidence for every finding, say why it matters here, and propose the smallest fix. Do not guess from a name alone.
- Tag each finding **Important** (breaks a rule above or changes behavior), **Nit** (at most three per review), or **Pre-existing** (not introduced by this change).
- Start the summary with the number of Important findings. When there is nothing to fix, say so plainly.

## Rounds and answers

- At most three review rounds per change. If findings keep coming after the third, step back and reconsider the approach instead of patching again.
- Every finding gets an answer: fixed, wrong (with a reason), intentional (with a reason), or irrelevant.
