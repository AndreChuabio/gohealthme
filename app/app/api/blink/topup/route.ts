// POST /api/blink/topup
//   (file path: app/app/api/blink/topup/route.ts -> route /api/blink/topup)
//
// One-tap Blink top-up that credits the in-app GoHealthMe balance. Blink's
// hosted deposit widget renders in a cross-origin iframe that the browser
// blocks on the deployed domain (third-party storage/passkey context), so the
// deployed flow credits the balance here directly. The real on-chain
// settlement happens on "Move balance to Arc wallet", where the treasury sends
// USDC to the user on Arc.
//
// Idempotent by a client-supplied ref (a fresh UUID per tap), so a retried
// request never double-credits.
//
// Request JSON:  { address: string, ref: string }
// Response JSON: { balanceUusdc: string, applied: boolean } | { error: string }

import { isAddress, type Address } from "viem";
import { credit, getBalance } from "@/lib/server/balance";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

// Demo top-up amount: 10 USDC (6-decimal micro-USDC).
const TOPUP_UUSDC = 10_000_000n;

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { address, ref } = body;

    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof ref !== "string" || ref.trim() === "") {
      return jsonError(400, "ref must be a non-empty idempotency string");
    }

    const result = await credit(address as Address, TOPUP_UUSDC, ref);
    const balance = await getBalance(address as Address);
    return Response.json({
      balanceUusdc: balance.toString(),
      applied: result.applied,
    });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
