# AGENTS.md

Repository contract for AI agents and human contributors working on `mantle-agentic-meme-launchpad`.

## What this is

An agentic meme launchpad POC on Mantle Sepolia, driven by an AI agent through Telegram (OpenClaw).
The agent trades from a 7702 smart account with a scoped, revocable session key; all transactions are gasless via the Mantle 7702 sponsor relayer.

The spec of record is [docs/DESIGN.md](docs/DESIGN.md) v0.2.

## Upstream collaboration rule (DESIGN §11.1)

- This repository depends on the `@0xwh1sker/mantle-aa-*` packages from npm.
- **Never patch, vendor, or fork AA SDK code** (no `node_modules` patches, no copied sources).
- Pin dependencies to published versions (`~0.1.4` in 0.1.0; `~0.1.5` in 0.1.1).
- Blocking AA SDK needs must be filed in the `mantle-7702-sdk` Linear project.

## Build, test and checks

```bash
# TypeScript workspace
pnpm install
pnpm lint        # Biome check
pnpm format      # Biome format write
pnpm typecheck   # tsc
pnpm test        # Vitest
pnpm build       # Build packages
pnpm check       # lint + typecheck + test

# Foundry contracts
cd contracts
forge fmt --check
forge build --sizes
forge test -vvv
```

## Git workflow and lanes

- **Lanes:**
  - Version-scoped work: worktree off `origin/release/v{version}` -> PR base `release/v{version}` (squash).
  - Bootstrap (before first production tag): resolves to `dev` -> PR base `dev` (squash).
  - Governance (carve-out files only): worktree off `origin/dev` -> PR base `dev` (squash).
  - Hotfix: worktree off `origin/main` -> PR base `main` (merge commit).
- **Neutral GitHub surface:** no tracker IDs, roles, models, effort or internal process paths on branch names, commit messages or PR text.
