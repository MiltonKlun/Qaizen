# Gate canaries

> A human gate is a judge like any other: until its error rate is measured,
> an approval says the reviewer pressed a key, not that a defect would have
> been caught. Canaries measure it. This doc describes the Gate 2 canaries the
> runner plants today, the Red-domain value question, how the results are
> counted, and the options for Gate 4, which are not built yet.

---

## 1. Gate 2: planted cases

Before Gate 2 the reviewer decides each draft test case, one at a time
(`docs/review-gates.md`, Gate 2). While they do, the runner
(`scripts/lib/canaries.js`) plants **canaries**: synthetic cases shown among
the real ones, exactly as a real case is shown (id, title, automation
decision, priority, the risk it covers).

- **What a canary is.** A case whose title contradicts one of the story's
  acceptance criteria (a comparison reversed, a number changed, a negation
  dropped or added) or states a business rule the story never does ("Guest
  shoppers can keep at most three items in the cart"). A reviewer reading the
  case against the story rejects it.
- **Who plants it.** The runner, at random, never the maintainer: a reviewer
  who knows where the defect is proves nothing.
- **How often.** Each real decision brings a canary with probability 1 in 10,
  at a random place among the cases (design decision D9 of the improvement
  plan: about one in ten decisions, starting with the Gate 2 loop). Most
  sessions have none; a long one may have two.
- **The reveal.** Right after the reviewer decides a canary, the runner says
  it was one, what it changed, and whether it was **caught** (rejected) or
  **missed** (approved). The reveal is immediate, because a canary that is
  never revealed teaches nothing and one revealed later is forgotten.

**Isolation.** A canary exists in memory and in the runner's log only. It is
never written to `test-cases/` or any other agent-owned folder, it never
enters the digest Gate 2 binds, and it never changes a real decision: the
decisions saved are those of the real drafts, exactly as they would be
without canaries (`test/canaries.test.js` proves the saved cases and the
digest are byte-identical with and without them). Quitting the loop saves no
case decision, but keeps the canaries already decided in the log.

**Known tells.** A canary's id is the next unused one, so it can sit out of
sequence among the cases; its title is a criterion's outcome or a stock rule,
not the Test Designer's wording. In a Red-domain story a canary is never P0,
because a real P0 there asks the value question below, which a canary could
not answer. Each tell lowers the measured catch rate's meaning a little; the
reviewer is asked to judge content, not ids.

## 2. Red-domain P0 cases: the value comes first

For a story that touches a Red domain (pricing, payment, permissions and the
rest, `scripts/red-domains.js`), each **P0** case asks the reviewer, before
the agent's expected results are shown, to type the value the case must
expect, from the story. The runner then shows the agent's expected results
and says whether the typed value appears in them. Nothing is blocked: the
point is that an approval of a money or permission case starts from the
reviewer's own reading of the story, not from a number the agent proposed.
The log records whether the value matched, never the value itself.

## 3. The log and the metrics

Every canary, every value question and every completed loop is appended to
`gates/canaries.json` (`schemas/canary-log.schema.json`), which only the
runner writes and which is archived with the run like the rest of `gates/`.
`npm run metrics` reads it from every archived run and reports
(`scripts/pipeline-metrics.js`, "Gate 2 canaries"):

- the **catch rate**: canaries rejected out of canaries planted, with a
  Wilson 95% interval, and by kind (comparison, number, negation, invented
  rule);
- the **false-alarm ceiling**: real cases rejected out of real cases decided,
  with its interval. Some rejections are right, so this is an upper bound on
  how often the reviewer rejects a case that was fine;
- how often the typed Red-domain value matched the agent's.

The counts are small for a long time: 7 caught out of 10 is consistent with
a true catch rate from about 40% to 89%. Read the interval, not the point.
The metrics also count Gate 1 and Gate 2 rejections next to Gate 3 and 4.

## 4. Gate 4: options, not built

At Gate 4 the reviewer reads the real generated test against the real spec.
Planting a weakened assertion there would mean writing into `tests/` (the
Generator's folder) or `specs/` (the Planner's), which folder ownership
forbids, and a planted defect in the reviewed file would sit inside the
digest the approval binds. The options recorded before anything is built:

| Option                                 | How                                                                                                                                                                                                                   | Folder ownership and digests                                | Measures                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| A. Planted scan finding                | The Gate 4 scan's findings are answered one by one (`docs/review-gates.md`, Gate 4). The runner adds a synthetic finding that names a real line but a weakness that is not there; the reviewer should answer "wrong". | Runner-owned only; the test file is untouched.              | Whether answers are read, not whether the test is.                    |
| B. A shown excerpt                     | The runner shows, in the brief only, a short excerpt of the real test with one assertion weakened (a matcher loosened, an expected value changed) and asks whether it matches the file.                               | Runner-owned; the file and digest are untouched.            | Attention to assertions, on a copy the reviewer knows may be altered. |
| C. A canary test in a runner workspace | The runner copies the test into `.qaizen/` with one mutation and asks the reviewer to review that copy as a separate, labelled item before the real one.                                                              | Runner-owned scratch; never under `tests/`.                 | Closest to the real task, at the cost of a second review.             |
| D. Mutation after the decision         | After approval, the runner applies a known mutation (Bench Shop bug switches, assertion mutations) and checks that the approved test fails.                                                                           | Read-only on `tests/`; measures the test, not the reviewer. | The test's oracle strength, which the reviewer approved.              |

None is chosen. A and B are cheap and isolated; C is the most faithful but
doubles Gate 4's work; D measures the artifact rather than the review, and
belongs with fault injection. A decision needs the Gate 2 catch rate first,
to see whether canaries change reviewer behavior at all.

## 5. What this is not

- **Not a gate.** A missed canary blocks nothing and is not a rejection. The
  decision on the real cases is the reviewer's, and the runner never makes
  it for them.
- **Not a test of the agents.** The agents' error rates are measured by the
  regression set (`docs/prompt-versioning.md` §3a); canaries measure the
  human.
