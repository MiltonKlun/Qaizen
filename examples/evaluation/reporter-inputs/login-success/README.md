# Reporter evaluation inputs — login-success (STORY-001)

The run a Reporter candidate reports on, for the reporter stage of
`scripts/evaluate-agents.js` (`docs/prompt-versioning.md` §3). Copy this
directory, run the Reporter on it, then:

```bash
node scripts/evaluate-agents.js --candidate-dir <copy> --stage reporter \
  [--baseline <previous evaluation-results.json>]
```

**This is a synthetic run, not evidence.** It was built in a temporary
workspace from the gold story (`examples/stories/login-success.md`), its gold
context and test cases (all set to approved), and the gold external plan:

- Synthetic Playwright and Newman reports: TC-001 passes, TC-002 fails once
  then passes (flaky), and the API request for TC-003 gets 200 where 403 is
  required. The raw reports are not kept here (`reports/` is never committed).
- `analysis/execution-ledger.json` came from the real normalizer
  (`npm run normalize`), with TC-004's manual result recorded through the real
  `scripts/import-execution.js` against small placeholder evidence files.
- `analysis/failure-analysis.json` came from the real pre-classifier
  (`npm run classify`); the Failure Classifier's finalizing step then confirmed
  both classifications, wrote `release/bug-drafts/BUG-001.md` for the Red
  failure, and set `status: "finalized"`.

The review gates in `context.json` are bound programmatically, the way the
test suite builds completed runs; their reviewer is
`synthetic fixture (not a human decision)`. No human approved anything here.
The bindings are digests of these exact bytes, so the directory is excluded
from formatting (`.prettierignore`), like archived runs.
