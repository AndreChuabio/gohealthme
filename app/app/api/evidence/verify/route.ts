// POST /api/app/api/evidence/verify
//   (file path: app/app/api/evidence/verify/route.ts → route /api/evidence/verify)
//
// Document-verified health goals. A participant uploads a health document
// (flu-shot record, lab/cholesterol PDF, biometric screening result); Claude
// judges whether it satisfies the pool goal; if verified with non-low confidence
// we record the verdict on-chain for (poolId, address) on HealthPools so the
// pool can settle. Mirrors the UnitedHealthcare "confirm your flu shot / get a
// screening, earn $X" model.
//
// Request JSON:
//   { poolId: number, address: string, goalSpec: string,
//     fileBase64: string, fileName: string, contentType: string }
//   contentType is image/png, image/jpeg, or application/pdf.
//
// Response JSON:
//   { verified, confidence, reason, recorded: boolean, txHash?, error? }
//
// Privacy: the document is sent to the judge for inference only. It is NOT
// persisted to disk or chain and no raw health data is logged — only the verdict
// (verified/confidence/reason) is recorded on-chain.

import { isAddress, type Address } from "viem";
import { recordResult } from "@/lib/server/oracle";
import {
  isSupportedContentType,
  judgeDocument,
  multiplierForConfidence,
  type SupportedContentType,
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

    const { poolId, address, goalSpec, fileBase64, contentType } = body;

    // Accept poolId as a number or a decimal string (the frontend serializes the
    // bigint pool id to a string, since JSON cannot carry bigint). Coerce + validate.
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
    if (typeof fileBase64 !== "string" || fileBase64.trim() === "") {
      return jsonError(400, "fileBase64 must be a non-empty base64 string");
    }
    if (typeof contentType !== "string" || !isSupportedContentType(contentType)) {
      return jsonError(
        400,
        "contentType must be one of image/png, image/jpeg, application/pdf",
      );
    }

    // Step 1 — JUDGE the document (Claude, or deterministic mock if no API key).
    // judgeDocument never throws; on any error it returns an unverified verdict.
    const verdict = await judgeDocument(
      goalSpec,
      fileBase64,
      contentType as SupportedContentType,
    );

    // Only record when the document genuinely satisfies the goal with
    // sufficient confidence. Low-confidence "yes" is treated as not good enough.
    const shouldRecord = verdict.verified && verdict.confidence !== "low";

    if (!shouldRecord) {
      return Response.json({
        verified: verdict.verified,
        confidence: verdict.confidence,
        reason: verdict.reason,
        recorded: false,
      });
    }

    // Step 2 — RECORD on-chain via the oracle signer.
    const multiplierBps = multiplierForConfidence(verdict.confidence);
    try {
      const txHash = await recordResult(
        BigInt(poolId),
        address as Address,
        true,
        multiplierBps,
      );
      return Response.json({
        verified: verdict.verified,
        confidence: verdict.confidence,
        reason: verdict.reason,
        recorded: true,
        txHash,
      });
    } catch (err) {
      const message = errorMessage(err);
      // recordResult requires the address to have already JOINED the pool.
      // Surface a clear, actionable error on the NOT_PARTICIPANT revert.
      if (message.includes("NOT_PARTICIPANT")) {
        return Response.json({
          verified: verdict.verified,
          confidence: verdict.confidence,
          reason: verdict.reason,
          recorded: false,
          error: `Document verified, but ${address} has not joined pool ${poolId}. Join the pool first, then re-submit your evidence.`,
        });
      }
      // Any other on-chain failure: verdict stands, recording failed.
      return Response.json({
        verified: verdict.verified,
        confidence: verdict.confidence,
        reason: verdict.reason,
        recorded: false,
        error: `Document verified, but recording on-chain failed: ${message}`,
      });
    }
  } catch (err) {
    // Last-resort guard — the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
