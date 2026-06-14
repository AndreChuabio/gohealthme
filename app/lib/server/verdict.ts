// HealthVerdict registry writer (server only) — Tier 1.
//
// In addition to recording the result on HealthPools (oracle.recordResult), the
// oracle writes the verdict into the HealthVerdict registry so HealthPools.settle
// can gate on canSettle(goalId). Same oracle key — it is the registry's
// authorized attester.
//
// The `digest` here is an ADVISORY content hash of the attester inference id: the
// poll-based live path (judge.ts) does not return the DON-signed inference digest
// — that is the CRE / onReport path (Tier 2). canSettle ignores the digest; it
// gates only on verified + confidence. No raw health data is hashed or stored.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optionalEnv, requireEnv } from "@/lib/server/env";
import type { Confidence } from "@/lib/server/judge";

const HEALTH_VERDICT_ABI = [
  {
    type: "function",
    name: "recordVerdict",
    stateMutability: "nonpayable",
    inputs: [
      { name: "goalId", type: "bytes32" },
      { name: "verified", type: "bool" },
      { name: "confidence", type: "uint8" },
      { name: "digest", type: "bytes32" },
      { name: "bitmap", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

// Facet bits mirror HealthVerdict.sol. World ID gates the join and the attester
// proves the document, so a recorded verdict carries both facets.
const FACET_WORLD_ID = 1 << 1; // bit1
const FACET_AI_ATTESTED = 1 << 2; // bit2
const DEMO_BITMAP = FACET_WORLD_ID | FACET_AI_ATTESTED; // 6

const CONFIDENCE_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function arcTestnet() {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
  return defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function oracleAccount() {
  const pk = requireEnv("ORACLE_SIGNER_PRIVATE_KEY");
  return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
}

/** keccak256(abi.encode(uint256 poolId, address user)) — matches HealthVerdict.computeGoalId. */
export function computeGoalId(poolId: bigint, user: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "poolId", type: "uint256" },
        { name: "participant", type: "address" },
      ],
      [poolId, user],
    ),
  );
}

export type RecordVerdictOutcome =
  | { status: "recorded"; txHash: Hex; goalId: Hex }
  | { status: "already-recorded"; goalId: Hex }
  | { status: "skipped"; reason: string };

/**
 * Write the verdict into the HealthVerdict registry (the canSettle gate). No-op
 * when HEALTH_VERDICT_ADDRESS is unset (registry not wired -> back-compat).
 * Idempotent: a goalId already recorded resolves as "already-recorded". Callers
 * should treat a thrown error as non-fatal and not break the user flow.
 */
export async function recordVerdict(
  poolId: bigint,
  user: Address,
  verified: boolean,
  confidence: Confidence,
  attesterId: string,
): Promise<RecordVerdictOutcome> {
  const registry = optionalEnv("HEALTH_VERDICT_ADDRESS", "");
  if (registry === "") {
    return { status: "skipped", reason: "HEALTH_VERDICT_ADDRESS not set" };
  }

  const goalId = computeGoalId(poolId, user);
  const digest = keccak256(stringToBytes(attesterId)); // advisory content hash
  const chain = arcTestnet();
  const account = oracleAccount();
  const wallet = createWalletClient({ account, chain, transport: http() });
  const publicClient = createPublicClient({ chain, transport: http() });

  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: registry as Address,
      abi: HEALTH_VERDICT_ABI,
      functionName: "recordVerdict",
      args: [goalId, verified, CONFIDENCE_U8[confidence], digest, DEMO_BITMAP],
    });
    const txHash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") {
      throw new Error(`recordVerdict tx ${txHash} reverted`);
    }
    return { status: "recorded", txHash, goalId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ALREADY_RECORDED/.test(msg)) {
      return { status: "already-recorded", goalId };
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}
