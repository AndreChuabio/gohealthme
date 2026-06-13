// World ID cloud verification (server only).
//
// Verified from live docs (docs.world.org, fetched Jun 12 2026):
//   - World ID 4.0 verify endpoint: POST https://developer.world.org/api/v4/verify/{rp_id}
//     The IDKit result payload is forwarded as-is, no field remapping
//     ("protocol_version": "4.0", nonce, action, responses[]). Success
//     response carries top-level nullifier plus per-proof results[].
//   - Legacy (pre-4.0) IDKit payloads carry { proof, merkle_root,
//     nullifier_hash, verification_level } and verify against
//     POST https://developer.worldcoin.org/api/v2/verify/{app_id}.
// We detect which shape the frontend sent and route accordingly, because
// idkit 4.x can return either depending on portal app configuration.
//
// WORLD_APP_ID holds the Developer Portal identifier used in the URL path
// (rp_... for 4.0 apps, app_... for legacy apps).

import { requireEnv } from "@/lib/server/env";
import { readJson, writeJson } from "@/lib/server/store";

const VERIFICATIONS_FILE = "world-verifications.json";

interface V4ProofPayload {
  protocol_version: string;
  nonce: string;
  action?: string;
  responses: Array<Record<string, unknown>>;
}

interface LegacyProofPayload {
  proof: string;
  merkle_root: string;
  nullifier_hash: string;
  verification_level: string;
}

export type WorldProofPayload = V4ProofPayload | LegacyProofPayload;

interface V4VerifyResponse {
  success: boolean;
  nullifier?: string;
  code?: string;
  detail?: string;
  results?: Array<{ success: boolean; nullifier?: string; detail?: string }>;
}

interface LegacyVerifyResponse {
  success?: boolean;
  nullifier_hash?: string;
  code?: string;
  detail?: string;
}

export interface VerificationRecord {
  nullifierHash: string;
  poolId: string;
  verifiedAt: string;
}

// address (lowercase) -> poolId -> record
type VerificationMap = Record<string, Record<string, VerificationRecord>>;

function isV4Payload(proof: WorldProofPayload): proof is V4ProofPayload {
  return (
    typeof (proof as V4ProofPayload).protocol_version === "string" &&
    Array.isArray((proof as V4ProofPayload).responses)
  );
}

/**
 * Per-pool incognito action string: `<base>-<poolId>`. Each pool is its own
 * World action so a human gets a distinct nullifier per pool (one entry per
 * pool), instead of one shared nullifier that could only ever join one pool.
 * The base must match the client's NEXT_PUBLIC_WORLD_ACTION_ID.
 */
export function poolActionId(poolId: string | number): string {
  const base = process.env.WORLD_ACTION_ID ?? "join-pool";
  return `${base}-${poolId}`;
}

/**
 * Verify an IDKit proof payload against World's cloud verify API.
 * `action` is the per-pool action string the proof was generated for; the
 * caller builds it server-side from the pool id, so the client never gets to
 * claim its own action. Returns the nullifier hash on success, throws with
 * detail on failure.
 */
export async function verifyProof(
  proof: WorldProofPayload,
  action: string,
): Promise<string> {
  const appId = requireEnv("WORLD_APP_ID");
  const actionId = action;

  if (isV4Payload(proof)) {
    // Pin the action server-side; never trust the client's claimed action.
    const body = { ...proof, action: actionId };
    const res = await fetch(
      `https://developer.world.org/api/v4/verify/${appId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await res.json()) as V4VerifyResponse;
    if (!res.ok || !data.success) {
      throw new Error(
        `World ID v4 verification failed (${res.status}): ${data.code ?? ""} ${data.detail ?? JSON.stringify(data)}`,
      );
    }
    const nullifier =
      data.nullifier ?? data.results?.find((r) => r.success)?.nullifier;
    if (nullifier === undefined) {
      throw new Error(
        "World ID v4 verification succeeded but no nullifier was returned",
      );
    }
    return nullifier;
  }

  // Legacy payload shape.
  const res = await fetch(
    `https://developer.worldcoin.org/api/v2/verify/${appId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proof: proof.proof,
        merkle_root: proof.merkle_root,
        nullifier_hash: proof.nullifier_hash,
        verification_level: proof.verification_level,
        action: actionId,
      }),
    },
  );
  const data = (await res.json()) as LegacyVerifyResponse;
  if (!res.ok || data.success !== true) {
    throw new Error(
      `World ID legacy verification failed (${res.status}): ${data.code ?? ""} ${data.detail ?? JSON.stringify(data)}`,
    );
  }
  if (data.nullifier_hash === undefined) {
    throw new Error(
      "World ID legacy verification succeeded but no nullifier_hash was returned",
    );
  }
  return data.nullifier_hash;
}

export async function recordVerification(
  address: string,
  poolId: string,
  nullifierHash: string,
): Promise<void> {
  const map = await readJson<VerificationMap>(VERIFICATIONS_FILE, {});
  const key = address.toLowerCase();
  const byPool = map[key] ?? {};
  byPool[poolId] = {
    nullifierHash,
    poolId,
    verifiedAt: new Date().toISOString(),
  };
  map[key] = byPool;
  await writeJson(VERIFICATIONS_FILE, map);
}

export async function getVerification(
  address: string,
  poolId: string,
): Promise<VerificationRecord | null> {
  const map = await readJson<VerificationMap>(VERIFICATIONS_FILE, {});
  return map[address.toLowerCase()]?.[poolId] ?? null;
}
