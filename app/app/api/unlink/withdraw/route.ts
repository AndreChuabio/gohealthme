// POST /api/unlink/withdraw  Body: { address, amountUsdc }
// Withdraws the participant's private balance to their own EVM wallet (hides the source).
import { isAddress, type Address } from "viem";
import { participantUnlinkClient, ARC_USDC_ADDRESS } from "@/lib/server/unlink";
import { toBaseUnits } from "@/lib/usdc";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const { address, amountUsdc } = body;
    if (typeof address !== "string" || !isAddress(address))
      return jsonError(400, "address must be a valid 0x address");
    if (typeof amountUsdc !== "string" || amountUsdc === "")
      return jsonError(400, "amountUsdc required");
    const client = participantUnlinkClient(address);
    const tx = await client.withdraw({
      recipientEvmAddress: address as Address,
      token: ARC_USDC_ADDRESS,
      amount: toBaseUnits(amountUsdc),
    });
    return Response.json({ tx });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
