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
// Recording is TWO on-chain writes and both are required before a participant can
// actually be paid:
//   1. HealthPools.recordResult  — the oracle result
//   2. HealthVerdict.recordVerdict — the Chainlink registry entry that
//      HealthPools.settle() gates on via canSettle(goalId)
// With the settlement gate enabled, step 2 failing means the participant receives
// NOTHING at settlement. So recorded:true is returned only when BOTH have landed;
// a step-2 failure returns recorded:false with a retryable error. Reporting
// success on a failed step 2 would silently cost a verified user their payout.
//
// Stateless / Vercel-safe: there is NO server-side store. Record-once is enforced
// by the contracts, not server memory — both writes are one-shot and their
// ALREADY_RECORDED reverts are treated as success, so polling never double-submits
// and a poll after a partial failure retries only the part that is missing. A
// NOT_PARTICIPANT revert returns the verified verdict with recorded:false and a
// "join the pool first" message.
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

import { isAddress, type Address, type Hex } from "viem";
import { recordResult } from "@/lib/server/oracle";
import { recordVerdict } from "@/lib/server/verdict";
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

    const multiplierBps = multiplierForConfidence(v.confidence);
    const base = {
      status: "completed" as const,
      verified: v.verified,
      confidence: v.confidence,
      reason: v.reason,
    };

    // STEP 1 — the pool result on HealthPools. One-shot per participant per pool.
    // ALREADY_RECORDED means an earlier poll already landed it; that is success,
    // and we must still fall through to step 2 rather than returning here. The
    // old code returned early on ALREADY_RECORDED, which meant a participant whose
    // registry write had failed could NEVER get one — every subsequent poll
    // short-circuited before reaching it and reported success.
    let resultTxHash: Hex | undefined;
    try {
      resultTxHash = await recordResult(
        BigInt(poolId),
        address as Address,
        true,
        multiplierBps,
      );
    } catch (err) {
      const message = errorMessage(err);

      // recordResult requires the address to have JOINED the pool first.
      if (message.includes("NOT_PARTICIPANT")) {
        return Response.json({
          ...base,
          recorded: false,
          error: `Document verified, but ${address} has not joined pool ${poolId}. Join the pool first, then re-submit your evidence.`,
        });
      }

      if (!message.includes("ALREADY_RECORDED")) {
        return Response.json({
          ...base,
          recorded: false,
          error: `Document verified, but recording on-chain failed: ${message}`,
        });
      }
      // ALREADY_RECORDED — fall through to step 2.
    }

    // STEP 2 — the Chainlink verdict registry, which gates settlement.
    //
    // HealthPools.settle() pays a participant only when
    // HealthVerdict.canSettle(goalId) is true. A missing registry verdict means
    // this participant is paid NOTHING at settlement, so this write is REQUIRED,
    // not best-effort, and a failure must never be reported as success. Calling it
    // on every poll is what makes a previously-failed write recoverable.
    try {
      const vr = await recordVerdict(
        BigInt(poolId),
        address as Address,
        v.verified,
        v.confidence,
        attesterId,
      );
      console.log(`[verdict] HealthVerdict registry: ${vr.status}`);
    } catch (e) {
      const message = errorMessage(e);
      console.error(
        `[verdict] registry write FAILED for pool ${poolId} / ${address} — ` +
          `participant is NOT settleable until this succeeds: ${message}`,
      );
      return Response.json({
        ...base,
        recorded: false,
        txHash: resultTxHash,
        error:
          `Document verified and your result is on-chain, but the Chainlink verdict ` +
          `registry write failed, so this goal cannot pay out yet. Re-submit to retry — ` +
          `your result is already recorded and will not be duplicated. (${message})`,
      });
    }

    return Response.json({ ...base, recorded: true, txHash: resultTxHash });
  } catch (err) {
    // Last-resort guard — the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
