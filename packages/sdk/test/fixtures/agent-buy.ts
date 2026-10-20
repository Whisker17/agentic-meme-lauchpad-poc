// One OS process of the agent: opens the session of the agent home <home> (password from
// MANTLE_AA_KEYSTORE_PASSWORD), plans a buy of <amount> base units of <token>, prints "ready", waits
// for a line on stdin, then sends it with `execute` through the sponsor at <sponsorUrl>. Prints
// the hash and the journalled trades as one JSON line.
import { createInterface } from "node:readline";
import { loadDeployments, mantleSepolia, RelayerExecutor } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, createPublicClient, http } from "viem";
import { execute, openAgentSession, planBuy, quoteBuy } from "../../src/index.js";

const [rpcUrl, sponsorUrl, home, launchpad, token, amount] = process.argv.slice(2) as [
  string,
  string,
  string,
  Address,
  Address,
  string,
];
const book = loadDeployments();
const client = createPublicClient({ chain: mantleSepolia, transport: http(rpcUrl) });
const executor = new RelayerExecutor({ client, url: sponsorUrl, addresses: book });
const session = openAgentSession({ home, client, executor, addresses: book });

const amountIn = BigInt(amount);
const plan = planBuy({
  launchpad,
  quoteToken: book.mockUsd,
  token,
  recipient: session.account,
  amountIn,
  quote: await quoteBuy(client, launchpad, token, amountIn),
  deadline: (await client.getBlock()).timestamp + 300n,
});

process.stdout.write("ready\n");
for await (const _ of createInterface({ input: process.stdin })) break;

const { hash, trades } = await execute({ session, client, home, launchpad, calls: plan.calls });
process.stdout.write(
  `${JSON.stringify({ hash, trades }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`,
);
process.exit(0);
