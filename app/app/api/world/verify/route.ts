// POST /api/world/verify
// Body: { proof: <IDKit result payload, forwarded as-is>, poolId, address }
// Verifies the World ID proof against World's cloud verify API, records
// the (address -> poolId -> nullifier) pair in server state so the oracle
// refuses unverified users, and returns { ok: true, nullifierHash } for
// the frontend to submit joinPool(poolId, nullifierHash) itself.
//
// Proof-of-human is load-bearing here: without a valid proof this route
// throws, nothing is recorded, and /api/oracle/record will never sign a
// result for the address. The product genuinely breaks without World ID.

import { isAddress } from "viem";
import {
  poolActionId,
  recordVerification,
  verifyProof,
  type WorldProofPayload,
} from "@/lib/server/world";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    return jsonError(400, errorMessage(err));
  }

  const { proof, poolId, address } = body;
  if (proof === null || typeof proof !== "object") {
    return jsonError(400, "proof must be the IDKit result payload object");
  }
  if (typeof poolId !== "string" && typeof poolId !== "number") {
    return jsonError(400, "poolId must be a string or number");
  }
  if (typeof address !== "string" || !isAddress(address)) {
    return jsonError(400, "address must be a valid 0x address");
  }

  try {
    const action = poolActionId(String(poolId));
    const nullifierHash = await verifyProof(proof as WorldProofPayload, action);
    await recordVerification(address, String(poolId), nullifierHash);
    return Response.json({ ok: true, nullifierHash });
  } catch (err) {
    // Verification failures are 401: the proof did not check out.
    const message = errorMessage(err);
    const status = message.includes("Missing required env var") ? 500 : 401;
    return jsonError(status, message);
  }
}
