// Release gate of 0.1.2 (DESIGN §11): every item of DESIGN §9.1 on an anvil fork of Mantle Sepolia,
// through the real `mantle-meme` and `mantle-aa` binaries, the autopilot daemon, `tools/market-sim`
// and a `mantle-aa sponsor serve` process: the same flow (`flow.ts`) that `sepolia.ts` runs on the
// real chain. Throwaway keys; the market-sim EOAs get MNT with `anvil_setBalance`, the relayer is an
// anvil dev account.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, parseEther, toHex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, it } from "vitest";
import { startFork } from "../launchpad/fork.js";
import { Acceptance, runStep, STEPS } from "./flow.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const RELAYER = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 4,
});

describe.skipIf(!rpcUrl)(
  "§9.1 acceptance: items 1–8 through the binaries (fork)",
  { timeout: 180_000 },
  () => {
    let stopFork: (() => void) | undefined;
    let a: Acceptance | undefined;

    beforeAll(async () => {
      const fork = await startFork(rpcUrl as string);
      stopFork = fork.stop;
      const keys = [0, 1, 2].map(() => generatePrivateKey());
      const sim = keys.map((k) => privateKeyToAccount(k));
      const client = createPublicClient({ transport: http(fork.url) });
      for (const s of sim) {
        await client.request({
          method: "anvil_setBalance" as never,
          params: [s.address, toHex(parseEther("10"))] as never,
        });
      }
      a = new Acceptance({
        mode: "fork",
        rpcUrl: fork.url,
        relayerKey: toHex(RELAYER.getHdKey().privateKey as Uint8Array),
        sim,
        dir: mkdtempSync(join(tmpdir(), "meme-acceptance-fork-")),
        tickMs: 300,
        pollMs: 200,
        secrets: keys,
        log: process.env.ACCEPTANCE_LOG ? (line) => console.log(line) : () => {},
      });
      await a.start();
    }, 120_000);

    afterAll(async () => {
      await a?.stop();
      stopFork?.();
    }, 60_000);

    for (const step of STEPS) it(step.name, () => runStep(a as Acceptance, step));
  },
);
