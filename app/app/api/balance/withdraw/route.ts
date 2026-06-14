// POST /api/balance/withdraw
//   (file path: app/app/api/balance/withdraw/route.ts -> route /api/balance/withdraw)
//
// Move USDC from a user's GoHealthMe balance (funded via Blink on Base Sepolia)
// onto Arc as spendable USDC. The ledger is debited first, then the treasury
// delivers the same amount of Arc USDC to the user's wallet so the existing
// join/fund/back flows can pull from it. Keeping the user as the on-chain payer
// means no contract change and no participant-identity confusion.
//
// Idempotent by a client-supplied ref. If the treasury transfer fails after the
// debit, the debit is refunded so the user never loses balance to a failed move.
//
// Request JSON:
//   { address: string, amountUusdc: number|string, ref: string }
//
// Response JSON:
//   { txHash: string, balanceUusdc: string }
//   | { error: string }  (400 bad input / insufficient, 409 already moved,
//                          502 transfer failed, 500 unexpected)

import { isAddress, type Address } from "viem";
import { credit, debit, getBalance } from "@/lib/server/balance";
import { sponsorUsdc } from "@/lib/server/treasury";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

function parseAmountUusdc(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { address, amountUusdc, ref } = body;

    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof ref !== "string" || ref.trim() === "") {
      return jsonError(400, "ref must be a non-empty idempotency string");
    }
    const amount = parseAmountUusdc(amountUusdc);
    if (amount === null) {
      return jsonError(400, "amountUusdc must be a positive integer");
    }

    const recipient = address as Address;

    // Debit first, idempotent by ref. Insufficient balance is a 400; an
    // already-applied ref means this exact move was processed -> 409.
    let debited;
    try {
      debited = await debit(recipient, amount, ref);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }
    if (!debited.applied) {
      return jsonError(409, "This withdrawal was already processed.");
    }

    // Deliver spendable USDC on Arc. On any failure, refund the debit so the
    // balance is never lost to a failed transfer.
    let txHash: string;
    try {
      txHash = await sponsorUsdc(recipient, amount);
    } catch (err) {
      await credit(recipient, amount, `${ref}:refund`).catch(() => undefined);
      return jsonError(502, `Treasury transfer failed: ${errorMessage(err)}`);
    }

    const balance = await getBalance(recipient);
    return Response.json({ txHash, balanceUusdc: balance.toString() });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
