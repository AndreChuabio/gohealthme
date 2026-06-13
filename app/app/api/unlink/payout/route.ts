// POST /api/unlink/payout  Body: { address, poolId, goalId, rewardUsdc }
// Gates on World verification for the pool, resolves the recipient's Unlink address,
// then treasury deposit -> private transfer. Idempotent per goalId.
import { isAddress, type Address } from "viem";
import { getVerification } from "@/lib/server/world";
import { treasuryUnlinkClient, participantUnlinkClient, ARC_USDC_ADDRESS } from "@/lib/server/unlink";
import { runPrivatePayout } from "@/lib/server/unlink-payout";
import { getUnlinkAddress, linkUnlinkAddress } from "@/lib/server/claims";
import { toBaseUnits } from "@/lib/usdc";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const { address, poolId, goalId } = body;
    if (typeof address !== "string" || !isAddress(address))
      return jsonError(400, "address must be a valid 0x address");
    if (typeof poolId !== "string" && typeof poolId !== "number")
      return jsonError(400, "poolId required");
    if (typeof goalId !== "string" || goalId === "")
      return jsonError(400, "goalId required");

    const verification = await getVerification(address as Address, String(poolId));
    if (verification === null)
      return jsonError(403, `No verified World ID record for ${address} in pool ${String(poolId)}`);

    let recipient = await getUnlinkAddress(address);
    if (recipient === null) {
      const client = participantUnlinkClient(address);
      await client.ensureRegistered();
      recipient = await client.getAddress();
      await linkUnlinkAddress(address, recipient);
    }

    const rewardUsdc = typeof body.rewardUsdc === "string" ? body.rewardUsdc : "0.25";
    const result = await runPrivatePayout({
      goalId,
      recipientUnlinkAddress: recipient,
      amountBaseUnits: toBaseUnits(rewardUsdc),
      token: ARC_USDC_ADDRESS,
      treasury: treasuryUnlinkClient(),
    });
    return Response.json(result);
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
