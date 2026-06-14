// POST /api/oracle/record
// Headers: x-oracle-secret: <ORACLE_API_SECRET>
// Body: { poolId, address, goalDays?, threshold? }
//
// Reads Junction (health-data) progress for the address, derives the verdict
// (streak >= goalDays) and multiplier (base 10000, +2500 comeback bonus
// when the preceding week averaged under 60, capped at 30000), refuses
// addresses without a verified World ID record for the pool, and submits
// recordResult to HealthPools on Arc testnet.
// Returns: { txHash, verdict, multiplierBps, streakDays, nullifierHash }

import { timingSafeEqual } from "crypto";
import { isAddress, type Address } from "viem";
import { getProgress, isConnected } from "@/lib/server/junction";
import { getVerification } from "@/lib/server/world";
import { deriveMultiplierBps, recordResult } from "@/lib/server/oracle";
import { requireEnv } from "@/lib/server/env";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const expected = requireEnv("ORACLE_API_SECRET");
    const provided = request.headers.get("x-oracle-secret");
    if (provided === null || !secretMatches(provided, expected)) {
      return jsonError(401, "Missing or invalid x-oracle-secret header");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { poolId, address } = body;
    if (typeof poolId !== "string" && typeof poolId !== "number") {
      return jsonError(400, "poolId must be a string or number");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    const goalDays = typeof body.goalDays === "number" ? body.goalDays : 7;
    const threshold = typeof body.threshold === "number" ? body.threshold : 75;
    if (!Number.isInteger(goalDays) || goalDays < 1 || goalDays > 100) {
      return jsonError(400, "goalDays must be an integer in 1..100");
    }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
      return jsonError(400, "threshold must be an integer in 1..100");
    }

    // Sybil gate: only humans verified for this pool get results recorded.
    const verification = await getVerification(address, String(poolId));
    if (verification === null) {
      return jsonError(
        403,
        `No verified World ID record for ${address} in pool ${String(poolId)}. Verify via /api/world/verify first.`,
      );
    }

    const connected = await isConnected(address);
    if (!connected) {
      return jsonError(
        404,
        `No health-data provider connected for ${address}. Connect via POST /api/junction/link.`,
      );
    }

    const progress = await getProgress(address, threshold, goalDays);
    const verdict = progress.streakDays >= goalDays;
    const multiplierBps = deriveMultiplierBps(progress.baselineWeekAvg);

    const txHash = await recordResult(
      BigInt(poolId),
      address as Address,
      verdict,
      multiplierBps,
    );

    return Response.json({
      txHash,
      verdict,
      multiplierBps: Number(multiplierBps),
      streakDays: progress.streakDays,
      nullifierHash: verification.nullifierHash,
    });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
