# mantle-meme OpenClaw skill

[SKILL.md](SKILL.md) teaches an OpenClaw agent to drive the launchpad through the `mantle-meme` CLI
(DESIGN §8.2). It is a skill only, no plugin: everything the agent can do is a `mantle-meme`
command, checked on chain by the session's policy.

## Tested version

OpenClaw: **pending** (the dry run below has not yet run against an installed OpenClaw). The
version it passes with is pinned here.

## Install

1. Build the CLI and put `mantle-meme` on the `PATH` of the OpenClaw process (the skill requires
   the binary and is not loaded without it):

   ```bash
   pnpm install && pnpm build
   mkdir -p ~/.local/bin
   printf '#!/bin/sh\nexec node %s/packages/cli/dist/bin/mantle-meme.js "$@"\n' "$PWD" \
     > ~/.local/bin/mantle-meme && chmod +x ~/.local/bin/mantle-meme
   ```

2. Point OpenClaw at this repository's `skills/` in `~/.openclaw/openclaw.json` (or copy
   `skills/mantle-meme/` into the agent workspace's `skills/`):

   ```json5
   { skills: { load: { extraDirs: ["/path/to/repo/skills"] } } }
   ```

3. The human sets up the account in the root terminal and exports the agent home (DESIGN §8.1,
   [packages/cli/README.md](../../packages/cli/README.md) "Human setup"). Then the OpenClaw
   process gets the **agent** environment, never the root one:

   | Variable | Value |
   | --- | --- |
   | `MANTLE_AA_HOME` | the exported agent home, e.g. `~/.mantle-meme-agent` |
   | `MANTLE_AA_KEYSTORE_PASSWORD` | the agent home's password (`MANTLE_AA_EXPORT_PASSWORD` at export) |
   | `MANTLE_AA_RPC_URL`, `MANTLE_AA_SPONSOR_URL` | the chain and the sponsor |
   | `MANTLE_MEME_TG_BOT_TOKEN`, `MANTLE_MEME_TG_CHAT_ID` | optional: autopilot pushes to Telegram |

   Set them in the environment OpenClaw starts with (or its `~/.openclaw/.env`). The skill also
   requires the first four, so it is not loaded without them: without `MANTLE_AA_HOME`,
   `mantle-meme` would fall back to `~/.mantle-aa`, the human's root home.

4. `openclaw skills check` should list `mantle-meme` as ready.

The agent home holds only the session key: the agent cannot grant, revoke or move funds. Revoke
with `mantle-aa session revoke --agent trader` in the root terminal.

## Dry run (fork, no Telegram)

[dry-run/dry-run.ts](dry-run/dry-run.ts) runs DESIGN §9.2 steps 2–8 on an anvil fork of Mantle
Sepolia: the §9.1 acceptance setup (sponsor, market-sim, the human's setup and the exported agent
home), one natural-language message per step to the agent, market-sim launches and a pump between
them, and a scrubbed `transcript.md` (message → the `mantle-meme` commands the agent ran → its
reply → checks). `DRY_RUN_AGENT` is the shell command for one agent turn (see the file's header).

```bash
pnpm build
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz \
  node --experimental-transform-types --no-warnings \
  --import ./packages/cli/test/fixtures/node-ts.mjs skills/mantle-meme/dry-run/dry-run.ts
```
