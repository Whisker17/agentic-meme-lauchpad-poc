# mantle-agentic-meme-launchpad

> **Status:** Proof of concept on Mantle Sepolia. **The contracts are not audited.**
> **Spec of record:** [docs/DESIGN.md](docs/DESIGN.md) (v0.2).

An agentic meme launchpad on Mantle Sepolia, driven end to end by an AI agent through natural language in Telegram (OpenClaw), with no front end. The agent trades from an EIP-7702 smart account with a scoped, revocable session key; every transaction is gasless.

Install and use: [docs/usage.md](docs/usage.md). The Telegram demo: [docs/demo.md](docs/demo.md).

## 文档

- [系统讲解](docs/onboarding/index.html)：7702 SDK、meme launchpad 和 OpenClaw 怎么配合。这是单个 HTML 文件，GitHub 只显示源码：clone 或下载仓库后，用浏览器打开 `docs/onboarding/index.html`。
- [复现手册](docs/runbook.md)：要自己跑一遍，照着它做，从 clone 到跑完整个演示。
- [演示实录](docs/example.md)：演示记录模板，跑完后填写结果、补上截图。
- [Telegram 演示](docs/demo.md)：演示脚本，逐条照做。
- [安装和使用](docs/usage.md)：演示之外怎么用。

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
