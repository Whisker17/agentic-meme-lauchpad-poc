import { agentPolicyHookAbi, caliburAbi, type Profile } from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  BaseError,
  type Client,
  ContractFunctionRevertedError,
  erc20Abi,
  getAddress,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import { DEFAULT_MAX_SCAN, scanTokens, TOKEN_STATUSES, type TokenStatus } from "./discovery.js";
import { memeLaunchpadAbi } from "./generated.js";
import { costBasis, readJournal } from "./journal.js";

export interface Position {
  token: Address;
  symbol: string;
  status: TokenStatus;
  /** The account's balance (may exceed what the session may sell). */
  balance: bigint;
  /** The session key's inventory on the hook: what it bought and may sell. */
  inventory: bigint;
  /** Weighted cost of the inventory incl. buy fees, from the journal; `null` = unknown. */
  costBasis: bigint | null;
  /** `quoteSell(inventory)`, net of the sell fee; `null` when the curve no longer trades. */
  sellValue: bigint | null;
  /** `sellValue − costBasis`; `null` when either is unknown. */
  unrealisedPnl: bigint | null;
}

export interface Portfolio {
  account: Address;
  keyHash: Hex;
  /** The key's Calibur expiry (unix seconds; 0 = never). */
  expiry: number;
  /** The hook's summary of the session. */
  session: { initialized: boolean; active: boolean; revoked: boolean };
  quote: { token: Address; balance: bigint; remainingLimit: bigint };
  positions: Position[];
}

export interface PortfolioOptions {
  client: Client;
  /** The agent home; its journal is the only source of cost basis. */
  home: string;
  /** The agent profile (`agentProfile(home)`); no root profile is needed. */
  profile: Profile;
  addresses: { memeLaunchpad: Address; agentPolicyHook: Address; mockUsd: Address };
  /** How many of the newest registry tokens are checked for a balance or inventory. */
  maxScan?: bigint;
}

/**
 * The session's minimal portfolio (DESIGN §5), read-only: every token the account holds or the key
 * has inventory of (newest `maxScan` registry entries, plus journalled tokens), with cost basis
 * and PnL; the quote balance and remaining limit; the hook summary and the key's expiry.
 */
export async function portfolio(o: PortfolioOptions): Promise<Portfolio> {
  const { client, profile } = o;
  const { memeLaunchpad: pad, agentPolicyHook: hook, mockUsd } = o.addresses;
  const account = getAddress(profile.account);
  const { keyHash } = profile;
  const journal = readJournal(o.home).filter(
    (r) => r.keyHash.toLowerCase() === keyHash.toLowerCase(),
  );
  const balanceOf = (token: Address) =>
    readContract(client, {
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  const hookRead = (functionName: "inventory" | "remainingLimit", token: Address) =>
    readContract(client, {
      address: hook,
      abi: agentPolicyHookAbi,
      functionName,
      args: [keyHash, account, token],
    });

  const scanned = await scanTokens(client, pad, o.maxScan ?? DEFAULT_MAX_SCAN);
  const tokens = [
    ...new Set([...scanned, ...journal.map((r) => r.token)].map((t) => getAddress(t))),
  ];
  const [settings, summary, quoteBalance, remainingLimit, held] = await Promise.all([
    readContract(client, {
      address: account,
      abi: caliburAbi,
      functionName: "getKeySettings",
      args: [keyHash],
    }),
    readContract(client, {
      address: hook,
      abi: agentPolicyHookAbi,
      functionName: "getSummary",
      args: [keyHash, account],
    }),
    balanceOf(mockUsd),
    hookRead("remainingLimit", mockUsd),
    Promise.all(
      tokens.map(async (token) => ({
        token,
        balance: await balanceOf(token),
        inventory: await hookRead("inventory", token),
      })),
    ),
  ]);

  const positions = await Promise.all(
    held
      .filter((h) => h.balance > 0n || h.inventory > 0n)
      .map(async ({ token, balance, inventory }): Promise<Position> => {
        const [symbol, state] = await Promise.all([
          readContract(client, { address: token, abi: erc20Abi, functionName: "symbol" }),
          readContract(client, {
            address: pad,
            abi: memeLaunchpadAbi,
            functionName: "curveState",
            args: [token],
          }),
        ]);
        const status = TOKEN_STATUSES[state.status] ?? "none";
        let sellValue: bigint | null = null;
        if (inventory === 0n) sellValue = 0n;
        else if (status === "trading") {
          sellValue = await readContract(client, {
            address: pad,
            abi: memeLaunchpadAbi,
            functionName: "quoteSell",
            args: [token, inventory],
          }).then(
            ([out]) => out,
            (e: unknown) => {
              // Dust whose sale would pay nothing.
              const revert =
                e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError);
              if (
                (revert as ContractFunctionRevertedError | null)?.data?.errorName === "ZeroOutput"
              )
                return 0n;
              throw e;
            },
          );
        }
        const basis = costBasis(journal, keyHash, token, inventory);
        return {
          token,
          symbol,
          status,
          balance,
          inventory,
          costBasis: basis,
          sellValue,
          unrealisedPnl: basis === null || sellValue === null ? null : sellValue - basis,
        };
      }),
  );

  return {
    account,
    keyHash,
    expiry: Number((settings >> 160n) & 0xff_ffff_ffffn),
    session: { ...summary },
    quote: { token: getAddress(mockUsd), balance: quoteBalance, remainingLimit },
    positions,
  };
}
