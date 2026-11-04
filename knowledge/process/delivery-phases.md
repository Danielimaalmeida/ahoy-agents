# Delivery phase table

This is the fixed lookup the Ahoy hosted harness uses on every step of a story. Nothing infers the next action from
conversation history: the reconciler reads the story's phase from its store, finds the matching row below, runs that
row's actor, runs that row's gate, and moves the story **on the gate's verdict**. It goes on until a human gate, a halt
or a terminal phase.

The machine-readable projection of this table is [phases.tsv](/knowledge/process/phases.tsv), which is what the
harness actually reads, at the commit each story pins when it is created. This document stays authoritative for humans
and for what each actor does. Keep the two in sync: phase names, actors, gates and targets.

**Gates are run by the harness, not by an agent.** An agent does a phase's work; it never decides whether the gate
passed and never writes the phase. An agent reporting on its own gate is grading its own homework, and the report is
indistinguishable from the truth until something independent checks.

The only other way a phase advances is a person's decision, recorded through the harness's API.

| phase | actor this step | action | gate | on pass → | otherwise → |
|---|---|---|---|---|---|
| *(story created)* | the harness | A person creates the story through the API with a Jira key and an AIU budget. The harness runs its preflight, pins this repository's commit, and creates the story's state from [state.template.json](/knowledge/process/state.template.json) | preflight | `intake` | The story is not created |
| `intake` | Intake analyst | Fetch Jira/Confluence facts and linked URLs. The Intake analyst writes `specs/<STORY-ID>/jira-source.md` and `intake_analyst.completeness` itself | the `intake` gate — it inspects the persisted snapshot; the Intake analyst's own `completeness` is an input, not the check | `planning` | `blocked`, with a `blocked` decision log entry. A PARTIAL or NOT_FOUND ticket halts for a person to fix it in Jira and resume |
| `planning` | Planner | Produce `specs/<STORY-ID>/implementation-plan.md` with work packages, their assigned specialists from `knowledge/repositories/`, and their dependency order. Populate `acceptance_criteria[]` (id, text, source_quote, repo, verification mode/rationale, and verification-anchor `test_ids`), `work_packages[]` and `branch_prefix`. Put every question for a person in `specs/<STORY-ID>/questions.json` and stop | the `plan` gate | `plan_review` | `stay`: a run that ends without a plan is unfinished, not failed. With open questions the story waits for a person's answers, and planning runs again with them |
| `plan_review` | Human | Approve the plan, send it back with a reason, or reject it | *(a person's decision only)* | `implementation`, once `plan_accepted` is approved | Waits for a person. Send back returns it to `planning` with the reason; reject sends it to `blocked` |
| `implementation` | the harness → the specialist each work package names | One run per work package, in the plan's dependency order, on the repository's story branch. The specialist changes code and tests, runs them, commits, and writes a handoff report; the harness pushes the branch and opens the pull request once the repository's work reports `ready` | the `child_ready` gate per repository (the pull request exists and its CI is green); once **all** pass, the `pr` gate | `pr_review` | Red CI branches back to `implementation` and reopens that repository's packages with the failing checks. A package reported `blocked`, `unverified`, failed or stalled halts for a person (retry or accept it) |
| `pr_review` | Reviewer, the one reviewer (D17) | Review every pull request at its head, from a local checkout of each, and write one report: a verdict per acceptance criterion and the findings. A report whose `reviewed_shas` still match the live heads is judged again rather than re-run | the `review` gate — a self-declared `CONSENSUS_READY` is never trusted | `delivery_gate` | `rework`, after the `rework_ceiling` gate, for unmet criteria or findings of medium severity or above. A head that moved since the review is re-reviewed. `BLOCKED`, or a clean review that asks for another round, halts for a person |
| `rework` | — | Pure routing row. The ceiling was already checked and incremented on entry from `pr_review`; the findings travel to the specialists as their rework note | *(none)* | `implementation` | — |
| `delivery_gate` | Human | Final acceptance | *(a person's decision only)* | `done`, once `delivery_accepted` is approved | Waits for a person. Send back reopens the delivered packages and goes to `implementation`; reject sends it to `blocked` |
| `done` | — | Terminal. No further action. Nothing is ever merged by the harness | — | — | — |
| `blocked` | Human | Resolve the blocker (update Jira, raise the rework ceiling) | — | A person unblocks the story, which goes back to the phase it was blocked from | Stays `blocked`. A story a person rejected cannot be unblocked |

## Gate verdicts

The harness routes on the verdict and nothing else.

| verdict | meaning | the harness does |
|---|---|---|
| `pass` | the condition holds | advance to `on pass` |
| `fail` | not yet | route to `on fail`; `stay` asks the gate again later |
| `branch` | work to do | route to `on branch` (rework), via the `rework_ceiling` gate |
| `reject` | the agent's output is not good enough | halt, and keep the reason for the actor's next run |
| `halt` | a person must decide | halt without changing phase |
| `error` | the gate could not run | halt; never a delivery condition and never a pass |

A gate name the harness does not know halts the story `unsupported_gate`.

## Notes

- **Human decisions go through the API only**, with the story's current version, and are kept with who made them and
  when. An approval is about a specific artifact: a plan approved three rounds of change ago is not self-evidently
  still approved. There is no timeout on a human gate.
- **No run waits for a person.** Every agent runs unattended. Only the planner asks people: it writes its questions to
  `specs/<STORY-ID>/questions.json` and stops, a person answers through the API, and the next planning run starts
  fresh with the answers at the top of its prompt and the draft plan on disk. Every other agent reports an open
  question in its output (an implementer as `blocker_question` with status `blocked`, the reviewer as a `BLOCKED`
  report) and stops.
- **A question that has been asked is not the agent's to withdraw.** From the agent's side `questions.json` is
  append-only: it may add questions, never remove, reword or answer one. An agent that finds the answer itself records
  it in the plan and leaves the question standing.
- **Sending back from a human gate** returns the story to the phase that produced the artifact, with the reason in the
  agent's prompt. A plan sent back starts a fresh planning run, and the previous plan is kept as
  `implementation-plan.round<N>.md`. A delivery sent back reopens the delivered work packages. There is a revision
  ceiling per gate.
- **Spend is bounded.** The story's AIU budget is a hard cap for all its runs together, and each run is also capped
  per phase. A story whose remaining budget cannot cover a run halts; a person can raise the budget and resume.
- **The `rework_ceiling` gate** counts rework rounds per repository. It runs only on the way from `pr_review` to
  `rework`. At the ceiling the story goes to `blocked`, and a person can raise it.
- **One reviewer (D17).** `pr_review` runs the agent its row names, once per round, and its report replaces the
  previous round's. The harness records the model it assigned, not one the reviewer reports about itself. A finding of
  medium severity or above is work and goes to rework; a reviewer that cannot judge reports `BLOCKED`, which halts for
  a person rather than sending a fixer after something nobody has shown is wrong.
- **Tool grants come from each agent's own profile** (`tools:` in `.github/agents/<agent>.agent.md`). A fixed grant
  in the harness would silently overrule every profile.
- **Model and effort.** What a phase's agent runs on is decided, first to last, by: a revision's override, the story's
  own choice (through the API), the harness's phase configuration, the `model`/`effort` cells of
  [phases.tsv](/knowledge/process/phases.tsv), and the agent profile's `model:`. The model slots are `intake`,
  `planning`, `implementation` and `review`. Effort levels are `low`, `medium`, `high`, `xhigh` and `max`.
- **Nothing in the harness decides which specialist implements a work package**, nor the internal order of a
  repository's work. The plan assigns both, from the mappings under `knowledge/repositories/`. Keeping that out of the
  control plane is what stops repository-specific sequencing leaking into it.
- **Routine passing transitions are not logged** to the decision log; the story's events and gate records already
  reconstruct them. Only judgment calls, human decisions and revisions go in the decision log.
