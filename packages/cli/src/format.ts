import { formatUnits } from "viem";

/** MockUSD and meme token decimals. */
export const QUOTE_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;

/** An amount in human and base units. */
export const usd = (base: bigint) => ({ human: formatUnits(base, QUOTE_DECIMALS), base });
export const tok = (base: bigint) => ({ human: formatUnits(base, TOKEN_DECIMALS), base });

/** JSON with bigints as decimal strings. */
export const toJson = (value: unknown, indent?: number) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), indent);
