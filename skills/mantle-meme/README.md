# mantle-meme OpenClaw skill

[SKILL.md](SKILL.md) teaches an OpenClaw agent to drive the launchpad through the `mantle-meme` CLI
(DESIGN §8.2). It is a skill only, no plugin: everything the agent can do is a `mantle-meme`
command, checked on chain by the session's policy.

## Tested version

OpenClaw **2026.10.5** (`1b58cb9`), image
`ghcr.io/openclaw/openclaw:2026.10.5@sha256:f40d1e66fd14d8c5b49c832f4100f83b53fdc01f5108f7db11de38fd0ee6dbe5`,
in Docker. The dry run below passes §9.2 steps 2–8 with a real model, the autopilot daemon still
running after every turn that follows its start (see "Why the container has a launcher").

## Install (Docker)

OpenClaw runs in one long-lived container built from [docker/openclaw](../../docker/openclaw)
(`mantle-meme` is built into the image). It mounts only:

| Host | Container |
| --- | --- |
| `~/.mantle-meme-openclaw` (OpenClaw state and model login, dedicated to this) | `/home/node/.openclaw` |
| `~/.mantle-meme-agent` (the exported agent home, session key only) | `/home/node/.mantle-meme-agent` |
| this repository's `skills/` (read-only) | `/skills` |

Never mount `~/.mantle-aa`, `~/.openclaw`, `~/.ssh` or the docker socket. OpenClaw's sandbox stays
off (the container is the boundary). Run from the repository root:

1. Build the image:

   ```bash
   docker compose -f docker/openclaw/compose.yaml build
   ```

2. Log in to a model provider, once, as the owner (needs a TTY), and load this skill:

   ```bash
   mkdir -p ~/.mantle-meme-openclaw
   docker run --rm -it --entrypoint node -v ~/.mantle-meme-openclaw:/home/node/.openclaw \
     mantle-meme-openclaw:2026.10.5 openclaw.mjs models auth login
   docker run --rm --entrypoint node -v ~/.mantle-meme-openclaw:/home/node/.openclaw \
     mantle-meme-openclaw:2026.10.5 openclaw.mjs config set skills.load.extraDirs '["/skills"]' --strict-json
   ```

3. The human sets up the account in the root terminal and exports the agent home to
   `~/.mantle-meme-agent` (DESIGN §8.1, [packages/cli/README.md](../../packages/cli/README.md)
   "Human setup"). The container gets the **agent** environment, never the root one:

   | Variable | Value |
   | --- | --- |
   | `MANTLE_AA_HOME` | set by the compose file: `/home/node/.mantle-meme-agent` |
   | `MANTLE_AA_KEYSTORE_PASSWORD` | the agent home's password (`MANTLE_AA_EXPORT_PASSWORD` at export) |
   | `MANTLE_AA_RPC_URL`, `MANTLE_AA_SPONSOR_URL` | the chain and the sponsor; a service on this machine is `host.docker.internal`, not `127.0.0.1` |
   | `MANTLE_MEME_TG_BOT_TOKEN`, `MANTLE_MEME_TG_CHAT_ID` | optional: autopilot pushes to Telegram |

   The skill requires the first four, so it is not loaded without them: without `MANTLE_AA_HOME`,
   `mantle-meme` would fall back to `~/.mantle-aa`, which does not exist in the container.

4. Start it with those variables in the environment, and check the skill:

   ```bash
   docker compose -f docker/openclaw/compose.yaml up -d
   docker exec mantle-meme-openclaw node openclaw.mjs skills info mantle-meme   # Ready, visible to model
   ```

5. One agent turn (keep one `--session-id` for a conversation):

   ```bash
   docker exec mantle-meme-openclaw node openclaw.mjs agent --local --session-id demo --message "我有多少钱" --json
   ```

6. Stop and remove the container (the state and the agent home stay on the host):

   ```bash
   docker compose -f docker/openclaw/compose.yaml down
   ```

The agent home holds only the session key: the agent cannot grant, revoke or move funds. Revoke
with `mantle-aa session revoke --agent trader` in the root terminal. The container's environment
holds the agent password (visible to `docker inspect`): testnet only.

### Why the container has a launcher

OpenClaw 2026.10.5 owns every process its `exec` tool starts on Linux (a child subreaper, with no
switch to turn it off): anything a command leaves behind is killed when the command returns, and
what is still running is stopped when an `agent --local` turn ends. The daemon `autopilot start`
spawns is such a process, so started straight from the agent it would stop within milliseconds.

The image therefore runs two small files from [docker/openclaw](../../docker/openclaw), with no
change to `mantle-meme` itself:

- `launcher.mjs` is the container's main process (under the image's `tini`, outside OpenClaw's
  process tree). It listens on `/tmp/mantle-meme-launcher.sock`, inside the container and never on a
  mounted volume.
- `mantle-meme.mjs` is the `mantle-meme` on the agent's `PATH`. Every command runs the real CLI
  unchanged, except `autopilot start`, which it sends to the launcher with its working directory.

The launcher accepts only `autopilot start --strategy <file> [--agent <name>] [--json]`, resolves the
strategy against the caller's directory, runs the real `mantle-meme autopilot start` (no shell, the
container's environment) and relays its stdout, stderr and exit code as they are. So output and
exit codes match a direct call (44 for a second start, the 120 s report timeout); anything else is
refused with a usage error (exit 1). The daemon is the launcher's descendant and outlives the turn.
`autopilot stop|status|log` run directly.

The daemon gets the container's environment, not that of the `docker exec` that runs the turn: set
optional variables such as `MANTLE_MEME_AUTOPILOT_TICK_MS` when the container starts.

## Dry run (fork, no Telegram)

[dry-run/dry-run.ts](dry-run/dry-run.ts) runs DESIGN §9.2 steps 2–8 on an anvil fork of Mantle
Sepolia: the §9.1 acceptance setup (sponsor, market-sim, the human's setup and the exported agent
home), one natural-language message per step to the agent, market-sim launches and a pump between
them, and a scrubbed `transcript.md` (message → the `mantle-meme` commands the agent ran → its
reply → checks). `DRY_RUN_AGENT` is the shell command for one agent turn (see the file's header).

With OpenClaw in Docker (image built, owner logged in, `skills.load.extraDirs` set; the run
starts its own container on a throwaway agent home and removes it at the end, so no other
`mantle-meme-openclaw` container may run against the same state directory):

```bash
pnpm build
C='"$DRY_RUN_SKILLS/../docker/openclaw/compose.yaml"'
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz \
DRY_RUN_HOST=host.docker.internal \
DRY_RUN_CLI=/opt/mantle-meme/docker/openclaw/mantle-meme.mjs \
DRY_RUN_SETUP="MANTLE_MEME_AGENT_HOME=\"\$DRY_RUN_AGENT_HOME\" docker compose -f $C up -d --no-build \
  && docker exec mantle-meme-openclaw ln -sf /home/node/.mantle-meme-agent/.dry-run/mantle-meme /home/node/.local/bin/mantle-meme" \
DRY_RUN_TEARDOWN="docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot stop --json; docker compose -f $C down" \
DRY_RUN_AGENT='docker exec mantle-meme-openclaw node openclaw.mjs agent --local --session-id "$DRY_RUN_SESSION" --message "$DRY_RUN_MESSAGE" --json' \
  node --experimental-transform-types --no-warnings \
  --import ./packages/cli/test/fixtures/node-ts.mjs skills/mantle-meme/dry-run/dry-run.ts
```

The link replaces the container's `mantle-meme` with the recording shim (OpenClaw's shell resets
`PATH`); the shim records the command and runs the wrapper, so `autopilot start` still goes through
the launcher. The tested run is [dry-run/transcript.md](dry-run/transcript.md).
