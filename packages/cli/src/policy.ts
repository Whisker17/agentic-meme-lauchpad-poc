import {
  type CallPermission,
  DEFAULT_SESSION_TTL_SECONDS,
  type Policy,
  RuleKind,
  validatePolicy,
} from "@0xwh1sker/mantle-aa-sdk";
import { type Address, toFunctionSelector, zeroAddress } from "viem";

/** The launchpad functions a session may call, with their hook rule (DESIGN §6.2). */
const PERMISSIONS = [
  ["quote", "approve(address,uint256)", "ERC20_APPROVE"],
  ["launchpad", "buy(address,uint256,uint256,uint256,address)", "LAUNCHPAD_BUY"],
  ["launchpad", "sell(address,uint256,uint256,uint256,address)", "LAUNCHPAD_SELL"],
  ["launchpad", "createToken(string,string,string,string,bytes32)", "NONE"],
  ["launchpad", "claimCreatorFees(address)", "NONE"],
] as const;

/** The policy period: the per-day cap resets every 24 h. */
export const PERIOD_SECONDS = 86_400;
/** The widest launchpad `deadline` the hook accepts, in seconds from now. */
export const MAX_DEADLINE_WINDOW = 600;

export interface PolicyInitArgs {
  quoteToken: Address;
  launchpad: Address;
  /** Quote base units the session may spend in total. */
  total: bigint;
  /** Quote base units per 24 h. */
  perDay: bigint;
}

/**
 * The grant policy of DESIGN §6.2 as `mantle-aa account init --grant` / `session grant --policy`
 * read it: amounts as decimal strings, selectors as signatures, rule kinds by name. Checked with
 * the AA SDK's own `validatePolicy` before it is returned.
 */
export function policyFile(a: PolicyInitArgs) {
  const target = { quote: a.quoteToken, launchpad: a.launchpad };
  const permissions = PERMISSIONS.map(([to, selector, ruleKind]) => ({
    target: target[to],
    selector,
    ruleKind,
  }));
  const policy: Policy = {
    maxValuePerCall: 0n,
    mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
    quoteLimits: [{ token: a.quoteToken, totalCap: a.total, periodCap: a.perDay }],
    periodLength: PERIOD_SECONDS,
    permissions: permissions.map(
      (p): CallPermission => ({
        target: p.target,
        selector: toFunctionSelector(p.selector),
        ruleKind: RuleKind[p.ruleKind],
      }),
    ),
    trustedSpenders: [a.launchpad],
    maxDeadlineWindow: MAX_DEADLINE_WINDOW,
  };
  validatePolicy(policy);
  return {
    maxValuePerCall: "0",
    mntLimit: { token: zeroAddress, totalCap: "0", periodCap: "0" },
    quoteLimits: [
      { token: a.quoteToken, totalCap: a.total.toString(), periodCap: a.perDay.toString() },
    ],
    periodLength: PERIOD_SECONDS,
    permissions,
    trustedSpenders: [a.launchpad],
    maxDeadlineWindow: MAX_DEADLINE_WINDOW,
  };
}

/** The session expiry `mantle-aa` 0.1.5 grants (its grant takes no expiry). */
export const SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;
