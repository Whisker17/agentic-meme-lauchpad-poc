# mantle-agentic-meme-launchpad

> **Status:** Proof of concept on Mantle Sepolia. **The contracts are not audited.**
> **Spec of record:** [docs/DESIGN.md](docs/DESIGN.md) (v0.2).

An agentic meme launchpad on Mantle Sepolia, driven end to end by an AI agent through natural language in Telegram (OpenClaw), with no front end. The agent trades from an EIP-7702 smart account with a scoped, revocable session key; every transaction is gasless.

Install and use: [docs/usage.md](docs/usage.md). The Telegram demo: [docs/demo.md](docs/demo.md).

## Structure

- `contracts/`: Foundry project (MemeLaunchpad, MemeToken, invariants and fork tests)
- `packages/sdk/`: `@0xwh1sker/mantle-meme-sdk` TypeScript library
- `packages/cli/`: `@0xwh1sker/mantle-meme-cli` (`mantle-meme` CLI)
- `tools/market-sim/`: Non-LLM market simulator for launches and trades
- `skills/mantle-meme/`: OpenClaw skill definition
- `docker/openclaw/`: the OpenClaw container the skill runs in
- `scripts/`: `demo-up.sh` / `demo-down.sh` for the Telegram demo
- `docs/`: Design and acceptance specifications

## License

MIT
