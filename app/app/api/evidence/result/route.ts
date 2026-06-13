// POST /api/evidence/result
//   (file path: app/app/api/evidence/result/route.ts → route /api/evidence/result)
//
// Step 2 of the document-verified health-goal flow. The frontend polls this
// route with the attester job id from /api/evidence/submit. We GET the attester
// inference by id:
//   - still queued/running  -> { status: "verifying" }
//   - completed & verified (confidence != low) -> record on-chain via the oracle
//     and return the verdict + txHash + recorded flag
//   - completed & not verified (or low) -> return the verdict, recorded: false
//   - failed -> return the failed verdict, recorded: false
//
// Stateless / Vercel-safe: there is NO server-side store. Record-once is enforced
// by the contract, not server memory — a re-poll after recording catches the
// HealthPools ALREADY_RECORDED revert and treats it as success, so double
// polling never double-submits. A NOT_PARTICIPANT revert returns the verified
// verdict with recorded:false and a "join the pool first" message.
//
// Request JSON:
//   { attesterId: string, poolId: number|string, address: string, goalSpec: string }
//
// Response JSON:
//   { status: "verifying" }
//     | { status: "completed", verified, confidence, reason,
//         recorded: boolean, txHash?, error? }
//     | { status: "failed", verified, confidence, reason, recorded: false }
//
// Privacy: only the verdict (verified/confidence/reason) is returned and recorded
// on-chain. Document bytes never reach this route.

import { isAddress, type Address } from "viem";
import { recordResult } from "@/lib/server/oracle";
import {
  multiplierForConfidence,
  pollInference,
  type Verdict,
} from "@/lib/server/judge";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { attesterId, poolId, address, goalSpec } = body;

    if (typeof attesterId !== "string" || attesterId.trim() === "") {
      return jsonError(400, "attesterId must be a non-empty string");
    }
    if (
      (typeof poolId !== "number" && typeof poolId !== "string") ||
      !/^\d+$/.test(String(poolId))
    ) {
      return jsonError(400, "poolId must be a non-negative integer");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof goalSpec !== "string" || goalSpec.trim() === "") {
      return jsonError(400, "goalSpec must be a non-empty string");
    }

    // pollInference never throws: transport/parse errors surface as a "failed"
    // status with an unverified verdict.
    const { status, verdict } = await pollInference(attesterId, goalSpec);

    if (status === "verifying") {
      return Response.json({ status: "verifying" });
    }

    // status is "completed" or "failed"; verdict is non-null in both cases.
    const v = verdict as Verdict;

    // Only record when the document genuinely satisfies the goal with sufficient
    // confidence. A failed inference or a low-confidence "yes" is not enough.
    const shouldRecord =
      status === "completed" && v.verified && v.confidence !== "low";

    if (!shouldRecord) {
      return Response.json({
        status,
        verified: v.verified,
        confidence: v.confidence,
        reason: v.reason,
        recorded: false,
      });
    }

    // Record on-chain via the oracle signer.
    const multiplierBps = multiplierForConfidence(v.confidence);
    try {
      const txHash = await recordResult(
        BigInt(poolId),
        address as Address,
        true,
        multiplierBps,
      );
      return Response.json({
        status: "completed",
        verified: v.verified,
        confidence: v.confidence,
        reason: v.reason,
        recorded: true,
        txHash,
      });
    } catch (err) {
      const message = errorMessage(err);

      // Record-once: a re-poll after the verdict was already recorded reverts
      // with ALREADY_RECORDED. Treat that as success — the result is on-chain.
      if (message.includes("ALREADY_RECORDED")) {
        return Response.json({
          status: "completed",
          verified: v.verified,
          confidence: v.confidence,
          reason: v.reason,
          recorded: true,
        });
      }

      // recordResult requires the address to have JOINED the pool first.
      if (message.includes("NOT_PARTICIPANT")) {
        return Response.json({
          status: "completed",
          verified: v.verified,
          confidence: v.confidence,
          reason: v.reason,
          recorded: false,
          error: `Document verified, but ${address} has not joined pool ${poolId}. Join the pool first, then re-submit your evidence.`,
        });
      }

      // Any other on-chain failure: verdict stands, recording failed.
      return Response.json({
        status: "completed",
        verified: v.verified,
        confidence: v.confidence,
        reason: v.reason,
        recorded: false,
        error: `Document verified, but recording on-chain failed: ${message}`,
      });
    }
  } catch (err) {
    // Last-resort guard — the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
