---
name: ahoy-design-check
description: Check a built UI against the story's Figma frames with the Playwright browser tools, measure every tagged element, fix what is off and report each frame in design_check. Use when the run has a design (specs/<KEY>/design/index.json) and the Playwright MCP tools.
---

# Ahoy design check

The story's design is in `.ahoy/specs/<KEY>/design/`: `index.json` lists the frames, `frames/<frame>.json` holds each
frame's node tree, and `frames/*.png` holds the images the workflow could download. You decide which screen and state
each frame shows and how to get there; the measuring and the comparison are fixed, so that "close" is never read as
"the same".

Tolerance: a box (position or size, from the frame's top left corner; an auto-width text by its characters) more
than 2 px off, a line height or a corner more than 1 px off, any difference in colour, font family, size, weight, case
or decoration, and a corner, border, shadow or background the design's box does not have, is a mismatch.

## This check is required

With the browser tools, run this skill in every run of a package that has a design, before you write the report: also
when the branch holds earlier work, when you changed little or nothing, and when the UI looks right to you. Looking at
the frame images and the code is not the check, and a claim that a frame "already matches" without the measured
numbers is not evidence. The run has no time limit: time, effort, the size of the change and the risk of starting the
app are never a reason to skip it.

A frame may stay `unchecked` only for one of these reasons, written in its `reason`:

| Reason                             | What the `reason` says                                    |
| ---------------------------------- | --------------------------------------------------------- |
| The browser tools are missing      | that the prompt says so                                   |
| Its node tree is not in `.ahoy/`   | the frame file the prompt names as left out               |
| The app did not start              | the command you ran and its last error lines              |
| Its screen or state is unreachable | the route and the steps you tried, and where they stopped |
| It is not a screen                 | what it is (a cover, notes, a component sheet)            |

Any other reason is a skipped check, which the reviewer sends back.

## 1. Start the app

Start the app as the repository runs it locally, in the background, and wait until it answers:

| Repository                              | Start                                                                         | Test user (mock: not a real account) |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| r3da_cdm_frontend (`r3da_cdm_frontend`) | `npm run start:keycloak`: app on http://localhost:4200, mock API on port 3000 | user `testuser`, password `12345`    |

Stop the app when you are done and check that ports 4200 and 3000 are free again.

For a repository not listed, use its README's local start, with mocked data. Never use a real account or a token you
find in the environment. If the app does not start, report every frame `unchecked` with why, and stop this skill.

## 2. For each frame in index.json

1. Read the frame's node tree and image. Work out the route and the state it shows (data, an open dialog, an empty
   list, an error). Reach it with the repository's mocks or test data; log in with the test user if asked.
2. `browser_resize` to the frame's `size` (width, height), then `browser_navigate` to the route and bring the page
   into that state.
3. Tag what you built with the frame's node ids, at runtime: `browser_evaluate` with a function that sets
   `data-figma-node="<node id>"` on the element of each node (the frame's own id on the element that is the frame, then
   every text, component instance and coloured box you built). Do not add these attributes to the code.
4. Measure: `browser_evaluate` with the whole text of `.github/skills/ahoy-design-check/measure.js` as `function`, and
   `filename` set to `.ahoy/design-check/<frame file>.measured.json` (the frame's file name, `12-34` for `12:34`).
5. Compare:
   `node .github/skills/ahoy-design-check/compare.mjs .ahoy/specs/<KEY>/design/frames/<frame file>.json .ahoy/design-check/<frame file>.measured.json`
   It prints one line per mismatch (`1:4 "Submit" box: design [16, 200, 120, 40], built [16, 204, 112, 36]`), then
   the nodes it could not compare because you tagged none.
6. Fix the code (the design kit's components, variants and tokens first), reload, and repeat 3 to 5 until it prints no
   mismatch, or every one left is explained by the plan or an acceptance criterion. Tag the nodes it says are not
   measured, so that the check covers the frame.
7. `browser_take_screenshot` with `filename` `.ahoy/design-check/<frame file>.png`.

Frames under one page that only document the design (a cover, notes) are not screens: report them `unchecked` with
that reason.

## 3. Report

Add `design_check` to your handoff report, one entry per frame of index.json:

```json
"design_check": [
  {
    "frame": "12:34",
    "screen": "/invoices, three invoices, filter open",
    "status": "checked",
    "mismatches": ["<each line compare.mjs still prints>"],
    "reason": "<why a mismatch stays, or why the frame is unchecked>"
  }
]
```

`unchecked` frames and mismatches that stay are not a reason for `unverified`: the reviewer judges them. A mismatch
left without a reason the plan or a criterion gives is a finding the reviewer sends back. Every `checked` frame has its
`.ahoy/design-check/<frame file>.measured.json` and screenshot; a frame without them is not checked.
