// POST /api/unlink/account  Body: { address }
// Ensures the signed-in user's Unlink account is registered; returns its unlink1 address.
import { isAddress } from "viem";
import { participantUnlinkClient } from "@/lib/server/unlink";
import { linkUnlinkAddress } from "@/lib/server/claims";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const address = (body as { address?: unknown }).address;
    if (typeof address !== "string" || !isAddress(address))
      return jsonError(400, "address must be a valid 0x address");
    const client = participantUnlinkClient(address);
    await client.ensureRegistered();
    const unlinkAddress = await client.getAddress();
    await linkUnlinkAddress(address, unlinkAddress);
    return Response.json({ unlinkAddress });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
