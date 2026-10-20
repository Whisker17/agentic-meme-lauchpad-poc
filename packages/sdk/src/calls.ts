import type { Call } from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  type Hex,
  keccak256,
  toHex,
} from "viem";
import { DESIGN_CURVE_PARAMS } from "./curve.js";
import { memeLaunchpadAbi, memeTokenCreationCode } from "./generated.js";

/** Seconds a launchpad trade stays valid by default (inside the policy's 600 s window). */
export const DEFAULT_DEADLINE_SECONDS = 300n;

/** `now + 300 s` as a launchpad `deadline`. */
export function defaultDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000)) + DEFAULT_DEADLINE_SECONDS;
}

/** A fresh random CREATE2 salt; reusing creator + salt + name + symbol collides. */
export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

const call = (to: Address, data: Hex): Call => ({ to, value: 0n, data });

export interface CreateTokenArgs {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  salt: Hex;
}

export function createTokenCall(launchpad: Address, args: CreateTokenArgs): Call {
  return call(
    launchpad,
    encodeFunctionData({
      abi: memeLaunchpadAbi,
      functionName: "createToken",
      args: [args.name, args.symbol, args.description ?? "", args.imageUrl ?? "", args.salt],
    }),
  );
}

export function approveCall(token: Address, spender: Address, amount: bigint): Call {
  return call(
    token,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  );
}

export interface TradeArgs {
  token: Address;
  /** BUY: quote paid (fee included). SELL: tokens sold. */
  amount: bigint;
  minOut: bigint;
  deadline: bigint;
  recipient: Address;
}

export function buyCall(launchpad: Address, a: TradeArgs): Call {
  return call(
    launchpad,
    encodeFunctionData({
      abi: memeLaunchpadAbi,
      functionName: "buy",
      args: [a.token, a.amount, a.minOut, a.deadline, a.recipient],
    }),
  );
}

export function sellCall(launchpad: Address, a: TradeArgs): Call {
  return call(
    launchpad,
    encodeFunctionData({
      abi: memeLaunchpadAbi,
      functionName: "sell",
      args: [a.token, a.amount, a.minOut, a.deadline, a.recipient],
    }),
  );
}

/** `claimCreatorFees(token)`; only the token's creator may send it. */
export function claimCall(launchpad: Address, token: Address): Call {
  return call(
    launchpad,
    encodeFunctionData({ abi: memeLaunchpadAbi, functionName: "claimCreatorFees", args: [token] }),
  );
}

/**
 * The address `createToken(name, symbol, …, salt)` sent by `creator` deploys to, computed offline
 * exactly as `MemeLaunchpad.predictTokenAddress`. `totalSupply` is the launchpad's `TOTAL_SUPPLY`.
 */
export function predictTokenAddress(
  launchpad: Address,
  creator: Address,
  salt: Hex,
  name: string,
  symbol: string,
  totalSupply: bigint = DESIGN_CURVE_PARAMS.totalSupply,
): Address {
  const args = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }],
    [name, symbol, totalSupply],
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: launchpad,
    salt: keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]),
    ),
    bytecode: `${memeTokenCreationCode}${args.slice(2)}`,
  });
}
