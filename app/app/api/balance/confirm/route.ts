// POST /api/balance/confirm
//   (file path: app/app/api/balance/confirm/route.ts -> route /api/balance/confirm)
//
// Credits a GoHealthMe balance after a Blink top-up on Base Sepolia is
// confirmed. A separate agent builds the Blink widget; on a confirmed deposit
// it calls this route with the deposited address, the Blink tx hash, and the
// amount in uUSDC (integer micro-USDC, 6 decimals). The credit is idempotent by
// blinkTxHash, so retried calls never double-credit.
//
// SECURITY NOTE: This route trusts the caller (best-effort for the demo). It
// does NOT verify the Blink deposit on-chain. Production MUST fetch the Base
// Sepolia tx receipt for blinkTxHash, confirm it succeeded, that it transfers
// amountUusdc of USDC to the treasury, and that the recipient/sender match the
// address, BEFORE crediting. Without that check a caller can mint free balance.
//
// Request JSON:
//   { address: string, blinkTxHash: string, amountUusdc: string|number }
//     amountUusdc is integer micro-USDC; strings are preferred to avoid JS
//     float precision loss on large values.
// Response JSON:
//   { balanceUusdc: string, applied: boolean }
//     applied is false when blinkTxHash was already credited (no double-count).
//   { error: string } on 400 (bad input) or 500 (unexpected failure)

import { isAddress, type Address } from "viem";
import { credit } from "@/lib/server/balance";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

function parseAmountUusdc(value: unknown): bigint {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) {
      throw new Error("amountUusdc must be a non-negative integer string");
    }
    return BigInt(value.trim());
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("amountUusdc must be a non-negative integer");
    }
    return BigInt(value);
  }
  throw new Error("amountUusdc must be an integer string or number");
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { address, blinkTxHash, amountUusdc } = body;

    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof blinkTxHash !== "string" || blinkTxHash.trim() === "") {
      return jsonError(400, "blinkTxHash must be a non-empty string");
    }

    let amount: bigint;
    try {
      amount = parseAmountUusdc(amountUusdc);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }
    if (amount <= 0n) {
      return jsonError(400, "amountUusdc must be a positive integer");
    }

    // Production should verify the Base Sepolia tx receipt here (see header).
    const result = await credit(
      address as Address,
      amount,
      blinkTxHash.trim(),
    );

    return Response.json({
      balanceUusdc: result.balanceUusdc.toString(),
      applied: result.applied,
    });
  } catch (err) {
    // Last-resort guard -- the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
