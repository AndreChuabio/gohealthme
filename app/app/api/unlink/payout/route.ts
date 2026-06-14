// POST /api/unlink/payout
// Body: { address, poolId, goalId, unlinkAddress, rewardUsdc? }
// Gates on World verification for the pool, then treasury deposit -> private
// transfer to the user's wallet-derived Unlink address. Idempotent per goalId.
import { isAddress, type Address } from "viem";
import { getVerification } from "@/lib/server/world";
import { treasuryUnlinkClient, ARC_USDC_ADDRESS } from "@/lib/server/unlink";
import { runPrivatePayout } from "@/lib/server/unlink-payout";
import { linkUnlinkAddress } from "@/lib/server/claims";
import { toBaseUnits } from "@/lib/usdc";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const { address, poolId, goalId, unlinkAddress } = body;

    if (typeof address !== "string" || !isAddress(address))
      return jsonError(400, "address must be a valid 0x address");
    if (typeof poolId !== "string" && typeof poolId !== "number")
      return jsonError(400, "poolId required");
    if (typeof goalId !== "string" || goalId === "")
      return jsonError(400, "goalId required");
    if (typeof unlinkAddress !== "string" || unlinkAddress === "")
      return jsonError(400, "unlinkAddress required (wallet-derived, sent from browser)");

    const verification = await getVerification(address as Address, String(poolId));
    if (verification === null)
      return jsonError(
        403,
        `No verified World ID record for ${address} in pool ${String(poolId)}`,
      );

    // Persist the EVM address → Unlink address mapping for reference.
    await linkUnlinkAddress(address, unlinkAddress);

    const rewardUsdc =
      typeof body.rewardUsdc === "string" ? body.rewardUsdc : "0.25";

    // Register the treasury under this project before any shielded op. The
    // engine only issues authorization tokens for addresses it knows; an
    // unregistered treasury fails token issuance ("token provider failed").
    // ensureRegistered() is lazy-cached, so this is a no-op after the first call.
    const treasury = treasuryUnlinkClient();
    await treasury.ensureRegistered();

    const result = await runPrivatePayout({
      goalId,
      recipientUnlinkAddress: unlinkAddress,
      amountBaseUnits: toBaseUnits(rewardUsdc),
      token: ARC_USDC_ADDRESS,
      treasury,
    });

    return Response.json(result);
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
