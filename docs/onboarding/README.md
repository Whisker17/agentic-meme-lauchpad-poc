# Onboarding explainer

[`index.html`](index.html) is a one-page explainer, in Chinese, of how the 7702 smart-account SDK,
this meme launchpad and OpenClaw work together. It is written for developers new to the project.

Open it locally: clone the repository and open `docs/onboarding/index.html` in a browser. It is a
single offline file: inline CSS, inline SVG diagrams and a little inline JavaScript, with no
request at view time. GitHub shows its source, not the page.

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
| `overview` | The three layers; who holds which key | 0, 1 |
| `delegation-7702` | What an EOA becomes after the EIP-7702 upgrade | 2 |
| `policy-check` | What `AgentPolicyHook` checks in one call, and where it refuses | 2, 6 |
| `flow-buy` | A command buy from Telegram to the chain, gasless relayer path included | 2, 5 |
| `flow-create-devbuy` | How create + dev buy fit one batch | 3, 5 |
| `curve-truncation` | The bonding curve and the truncated final buy | 3 |
| `flow-autopilot` | Autopilot start → bought → take-profit, and crash recovery | 3, 5 |
| `flow-revoke` | How the agent and the autopilot stop after a revoke | 2, 5 |
| `container` | Process tree and mounts of the OpenClaw container | 4 |
| `trust-boundaries` | On-chain enforcement vs skill rules vs container isolation | 6 |
| `e2e-flow` | The DESIGN §9.2 demo, by actor | 5 |

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
