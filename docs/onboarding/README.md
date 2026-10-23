# Onboarding explainer

[`index.html`](index.html) is a one-page explainer, in Chinese, of how the 7702 smart-account SDK,
this meme launchpad and OpenClaw work together. It is written for developers new to the project, in
three parts:

1. **Principles** (sections 1–3): the 7702 SDK (design, how it works, how to use it), the
   components the launchpad adds on top of it, and how the two run as one system.
2. **A real run** (section 4): the nine demo steps as run on Mantle Sepolia on 2026-10-22, after a
   step 0 on funding (who needs MNT and why). Each step shows what it does, the code behind it, and
   its real input and output.
3. **Reference** (sections 5–8): security model, technology choices, known limits, code map.

Open it locally: clone the repository and open `docs/onboarding/index.html` in a browser. It is an
offline page: inline CSS, inline SVG diagrams, a little inline JavaScript and the screenshots in
`screenshots/`, with no request at view time. GitHub shows its source, not the page.

## Diagrams

Each diagram is an [Excalidraw](https://excalidraw.com) skeleton in `diagrams/<name>.mjs`, which
exports `skeleton` (the elements) and `alt` (its text alternative). `diagrams/lib.mjs` holds the
shared palette and helpers. `diagrams/render.mjs` renders every skeleton with the official
`@excalidraw/excalidraw@0.18.0` in headless Chrome and:

- writes `diagrams/<name>.excalidraw` (open it at excalidraw.com to edit by hand) and a minified
  `diagrams/<name>.svg`;
- replaces the SVG between `<!--diagram:<name>-->` and `<!--/diagram:<name>-->` in `index.html`.

| Diagram | Answers | Section |
| --- | --- | --- |
| `overview` | The three layers; who holds which key | 0, 3 |
| `delegation-7702` | What an EOA becomes after the EIP-7702 upgrade | 1 |
| `policy-check` | What `AgentPolicyHook` checks in one call, and where it refuses | 1, 5 |
| `flow-buy` | A command buy from Telegram to the chain, gasless relayer path included | 1, 3 |
| `flow-create-devbuy` | How create + dev buy fit one batch | 2, 3 |
| `curve-truncation` | The bonding curve and the truncated final buy | 2 |
| `flow-autopilot` | Autopilot start → bought → take-profit, and crash recovery | 2, 3 |
| `flow-revoke` | How the agent and the autopilot stop after a revoke | 1, 3, 4 |
| `container` | Process tree and mounts of the OpenClaw container | 2 |
| `trust-boundaries` | On-chain enforcement vs skill rules vs container isolation | 5 |
| `e2e-flow` | The DESIGN §9.2 demo, by actor | 3 |

Three more figures are plain HTML in `index.html`, not Excalidraw: `fig-sdk-arch` (the SDK's
packages and contracts), `fig-sdk-pipeline` (the five checks of one agent execution) and
`fig-pad-stack` (the components the launchpad adds). Edit them in place. Figure numbers are written
out in captions and cross-references; renumber them by hand when you add or move a figure.

## The real run (section 4)

`screenshots/step*.png` are the terminal and Telegram screenshots of the 2026-10-22 run, named by
step. The JSON in section 4 comes from that run's records: the agent's `exec` calls and their
output in the OpenClaw session log, the agent home's `meme/journal.jsonl` and
`meme/autopilot/events.jsonl`, and terminal output copied during recording. It is reformatted for
reading, not edited. The gas figures (step 0 and the ledger) are computed from the transactions'
receipts and match the relayer's balance change over the run. Step 0 itself was not recorded: it
follows `docs/runbook.md` section 5. A new run means new screenshots and new JSON; keep the step
layout (what it does, the code behind it, input, output).

## Regenerating

`render.mjs` is a development tool, not a dependency of this repository: it needs Google Chrome
and `puppeteer-core` from some other local Node project, and it loads Excalidraw from `esm.sh` while
it renders (the page itself never does).

```bash
# PUPPETEER_CORE_FROM: a package.json (or its directory) whose node_modules has puppeteer-core
# CHROME_PATH: optional, default /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
PUPPETEER_CORE_FROM=/path/to/a/project/package.json node docs/onboarding/diagrams/render.mjs
PUPPETEER_CORE_FROM=… node docs/onboarding/diagrams/render.mjs docs/onboarding/diagrams/flow-buy.mjs
```

Then run `pnpm format` (Biome formats the `.mjs` files) and check the page in a browser. Every
element has a fixed seed, so rendering the same skeleton again gives the same SVG.

Edit the prose in `index.html` directly. Keep the diagram markers in place.
