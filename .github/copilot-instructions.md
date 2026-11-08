# R3DA FIO Ahoy Workspace Instructions

This repository is the shared control plane for the software development team's agentic AI workflow. It contains reusable agents, generic skills, delivery process definitions, and curated repository knowledge. It must not contain application code.

## How you are run

The Ahoy harness runs you for one phase of one story at a time, unattended. It owns routing, gates, the story's state, pushes, pull requests and spend. Perform only the action your phase and your profile describe, write only the outputs they permit, and stop. Do not run gates, write `.phase`, or try to advance the story yourself.

## Operating rules

1. Deliver only user stories and bug fixes with an existing Jira issue key.
2. Read the relevant files in `knowledge/` before routing or planning work.
3. Select implementation agents from the registered agent and repository mappings (`knowledge/repositories/agent-mappings.md`); do not guess at ownership.
4. Make application changes only in the checkout of the child repository your run was given.
5. Read and follow each affected child repository's local instructions, conventions, workflows, and relevant files before implementation.
6. Keep repository-specific implementation details in the owning repository; keep shared process and reusable guidance here.
7. Every acceptance criterion must be verified by its named evidence; the reviewer and the harness's gates check this before delivery. Do not report work as done that you have not verified.
8. Preserve the human approval gates for the plan and the delivery. Agents never approve or merge pull requests, and never push or open them: the harness does.
9. No one answers questions during a run. When requested behavior, scope, ownership, or source facts are uncertain, do not assume:
   - the planner asks its questions as its prompt says (with the `ask_person` tool where the harness offers it, otherwise in `specs/<STORY-ID>/questions.json`) and stops; a person answers, and planning runs again with the answers;
   - every other agent reports the open question in its phase output (an implementer as `blocker_question` with status `blocked`, the reviewer as a `BLOCKED` report) and stops.
10. Do not commit secrets, credentials, generated application artifacts, or local working copies.

## Jira intake rules

11. Use the configured Jira MCP and the conventions in `knowledge/integrations/jira.md` and `.github/skills/jira-intake/SKILL.md` for story and bugfix intake.
12. Validate an exact issue key in the primary project, persist the result at `specs/<STORY-ID>/jira-source.md`, and have later agents consume that snapshot rather than Jira.
13. If the Jira issue changes after intake, say so in your output instead of working from the newer issue: the story goes back through intake and plan approval before implementation.

## Delivery flow

The phases are in `knowledge/process/phases.tsv`; what each actor does is in `knowledge/process/delivery-phases.md`.

1. **Intake:** validate the Jira issue and persist its source snapshot.
2. **Planning:** identify the affected repositories, owners, dependencies and specialists, and write one implementation plan with its work packages and the evidence for each acceptance criterion.
3. **Plan review:** a person approves the plan, or sends it back with a reason.
4. **Implementation:** one run per work package, in its child repository's checkout. The implementer changes code and tests, runs them, commits, and reports readiness per its handoff contract. The harness pushes the story branch and opens the pull request once the repository's work reports ready.
5. **Pull request review:** once the child repository's CI is green, one reviewer judges every acceptance criterion and the change itself. Unmet criteria and findings of medium severity or above go back to implementation as rework.
6. **Delivery gate:** a person accepts the delivery. Nothing is merged by an agent.

The harness keeps the story's state, review findings and spend. It hands an agent what it needs in `specs/<STORY-ID>/` (`state.json`, the plan, `jira-source.md`) and in its prompt (on rework, the findings to fix first). Write only the files your phase and profile permit.
