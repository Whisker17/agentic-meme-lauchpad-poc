import { readFileSync } from "node:fs";
import {
  type AddressBook,
  type DeploymentRecord,
  loadDeployments as loadAaDeployments,
} from "@0xwh1sker/mantle-aa-sdk";
import { type Address, getAddress, isAddress } from "viem";
import { MEME_MANTLE_SEPOLIA } from "./generated.js";

/** The shape of this repository's `deployments/<network>.json`. */
export interface MemeDeploymentRecord {
  chainId: number;
  /** An empty address means "not deployed yet". */
  MemeLaunchpad: { address: string };
}

/** The AA SDK's address book plus the meme launchpad (`null` until it is deployed). */
export interface MemeAddressBook extends AddressBook {
  memeLaunchpad: Address | null;
}

export interface LoadDeploymentsOptions {
  /** This repository's record or a path to one; default: the shipped Mantle Sepolia book. */
  meme?: string | URL | MemeDeploymentRecord;
  /** The AA SDK's record or a path to one; default: the AA SDK's shipped Mantle Sepolia book. */
  aa?: string | URL | DeploymentRecord;
}

/** Merges the meme deployment record with the AA SDK's address book of the same chain. */
export function loadDeployments(options: LoadDeploymentsOptions = {}): MemeAddressBook {
  const source = options.meme ?? MEME_MANTLE_SEPOLIA;
  const record: MemeDeploymentRecord =
    typeof source === "string" || source instanceof URL
      ? JSON.parse(readFileSync(source, "utf8"))
      : source;
  const aa = loadAaDeployments(options.aa);
  if (record?.chainId !== aa.chainId) {
    throw new Error(
      `Meme deployment chainId ${record?.chainId} does not match the AA chainId ${aa.chainId}`,
    );
  }
  const launchpad = record.MemeLaunchpad?.address;
  if (
    launchpad !== "" &&
    (typeof launchpad !== "string" || !isAddress(launchpad, { strict: false }))
  ) {
    throw new Error("Meme deployment record has no valid MemeLaunchpad address");
  }
  return { ...aa, memeLaunchpad: launchpad === "" ? null : getAddress(launchpad) };
}
