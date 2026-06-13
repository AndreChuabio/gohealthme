// Oracle signer for HealthPools on Arc testnet (server only).
//
// Arc testnet config (from docs.arc.io, captured in the build plan):
//   chain id 5042002, rpc https://rpc.testnet.arc.network,
//   native gas token is USDC (18 decimals as gas).
//
// The recordResult ABI below matches the design-freeze interface in the
// build plan: recordResult(poolId, user, verdict, multiplierBps), oracle
// signer only. If the contract agent changes parameter types this snippet
// must be updated to match the deployed ABI.

import {
  createWalletClient,
  createPublicClient,
  defineChain,
  http,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optionalEnv, requireEnv } from "@/lib/server/env";

const HEALTH_POOLS_ABI = [
  {
    type: "function",
    name: "recordResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "verdict", type: "bool" },
      { name: "multiplierBps", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const BASE_MULTIPLIER_BPS = 10_000n;
export const COMEBACK_BONUS_BPS = 2_500n;
export const MULTIPLIER_CAP_BPS = 30_000n;
export const COMEBACK_THRESHOLD = 60;

function arcTestnet() {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
  return defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
    },
  });
}

function oracleAccount() {
  const pk = requireEnv("ORACLE_SIGNER_PRIVATE_KEY");
  const normalized = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  return privateKeyToAccount(normalized);
}

/**
 * Derive the payout multiplier in basis points.
 * Base 1x (10000). Comeback bonus +2500 when the week preceding the
 * current streak window averaged below 60. Capped at 3x (30000),
 * matching the contract's trailing-baseline cap.
 */
export function deriveMultiplierBps(baselineWeekAvg: number | null): bigint {
  let bps = BASE_MULTIPLIER_BPS;
  if (baselineWeekAvg !== null && baselineWeekAvg < COMEBACK_THRESHOLD) {
    bps += COMEBACK_BONUS_BPS;
  }
  return bps > MULTIPLIER_CAP_BPS ? MULTIPLIER_CAP_BPS : bps;
}

/**
 * Submit recordResult(poolId, user, verdict, multiplierBps) to HealthPools
 * on Arc testnet and wait for inclusion. Returns the tx hash.
 */
export async function recordResult(
  poolId: bigint,
  user: Address,
  verdict: boolean,
  multiplierBps: bigint,
): Promise<Hex> {
  const contract = requireEnv("HEALTH_POOLS_ADDRESS") as Address;
  const chain = arcTestnet();
  const account = oracleAccount();

  const wallet = createWalletClient({ account, chain, transport: http() });
  const publicClient = createPublicClient({ chain, transport: http() });

  // simulate first so revert reasons surface as readable errors
  const { request } = await publicClient.simulateContract({
    account,
    address: contract,
    abi: HEALTH_POOLS_ABI,
    functionName: "recordResult",
    args: [poolId, user, verdict, multiplierBps],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`recordResult tx ${hash} reverted on Arc testnet`);
  }
  return hash;
}
