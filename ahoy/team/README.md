# Team additions to Ahoy's base agents

Ahoy ships its base agents (planner, reviewer, story-refiner, halt-diagnoser, knowledge-keeper, story-drafter,
density-reader) with the harness. A file here, named after the agent, adds this team's part to one:

- a frontmatter with `tools` (a one-line list, added to the base agent's tools) and `model`, and no other key;
- then, optionally, Markdown guidance appended to the base agent's text.

To replace a base agent entirely, put a full profile in `.github/agents/<name>.agent.md` with `ahoy-override: true` in
its frontmatter. Without that key, Ahoy ignores a profile there that has a base agent's name. The copies in
`.github/agents/` stay for the harness releases from before the base agents, until those are retired.
