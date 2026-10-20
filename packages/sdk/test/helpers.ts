import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Abi,
  BaseError,
  type Chain,
  type Client,
  ContractFunctionRevertedError,
  createWalletClient,
  type Hex,
  type HttpTransport,
  http,
  type PublicActions,
  publicActions,
  type WalletActions,
  type WalletRpcSchema,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const contracts = fileURLToPath(new URL("../../../contracts", import.meta.url));

export interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}

/**
 * A fresh `forge build` of the launchpad sources into a temporary directory, so the checks never
 * read a stale `contracts/out`. Same profile and sources as the deployment build.
 */
export function forgeBuild(): (name: string) => Artifact {
  const dir = mkdtempSync(join(tmpdir(), "meme-sdk-forge-"));
  execFileSync(
    "forge",
    [
      "build",
      "--out",
      join(dir, "out"),
      "--cache-path",
      join(dir, "cache"),
      "src/MemeLaunchpad.sol",
      "src/MemeToken.sol",
      "lib/mantle-7702-sdk/contracts/src/mocks/MockUSD.sol",
    ],
    { cwd: contracts, stdio: "pipe" },
  );
  return (name) =>
    JSON.parse(readFileSync(join(dir, "out", `${name}.sol`, `${name}.json`), "utf8"));
}

// anvil's first two default accounts.
export const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
] as const;

export type TestWallet = Client<
  HttpTransport,
  Chain,
  PrivateKeyAccount,
  WalletRpcSchema,
  WalletActions<Chain, PrivateKeyAccount> & PublicActions<HttpTransport, Chain, PrivateKeyAccount>
>;

/** Starts anvil (no skip when it is missing: the suite must run wherever it is collected). */
export async function startAnvil(): Promise<{ url: string; stop: () => void }> {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const client = walletClient(url, keys[0]);
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      return { url, stop: () => proc.kill() };
    } catch (err) {
      if (i > 100 || proc.exitCode !== null) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export function walletClient(url: string, key: Hex): TestWallet {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: foundry,
    transport: http(url),
  }).extend(publicActions);
}

/** The custom error name a contract call reverted with. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) throw err;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) throw err;
  return reverted.data?.errorName;
}
