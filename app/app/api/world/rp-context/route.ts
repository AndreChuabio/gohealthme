// GET /api/world/rp-context?poolId=<id>
//
// World ID 4.0 relying-party context. The IDKitRequestWidget needs a signed
// rp_context before it can request a proof. We sign it server-side with the RP
// signer key (WORLD_SIGNER_PRIVATE_KEY) using @worldcoin/idkit-server, scoped to
// the PER-POOL action (join-pool-<poolId>) so each pool yields a distinct
// nullifier (one entry per pool per human), and return the rp_context the
// widget expects. poolId is required and must match the action the widget and
// /api/world/verify use.
//
// Required env:
//   WORLD_SIGNER_PRIVATE_KEY  the RP signer key generated in the World dev portal
//   WORLD_RP_ID               the registered RP ID (format rp_...) from the
//                             "World ID 4.0" tab (NOT the app_ id)
// Optional:
//   WORLD_ACTION_ID           the action base (default "join-pool"); must match
//                             the client's NEXT_PUBLIC_WORLD_ACTION_ID

import { signRequest } from "@worldcoin/idkit-server";
import { requireEnv } from "@/lib/server/env";
import { poolActionId } from "@/lib/server/world";

export async function GET(request: Request) {
  try {
    const signingKeyHex = requireEnv("WORLD_SIGNER_PRIVATE_KEY").replace(/^0x/, "");
    const rpId = requireEnv("WORLD_RP_ID");

    const poolId = new URL(request.url).searchParams.get("poolId");
    if (poolId === null || !/^\d+$/.test(poolId)) {
      return Response.json(
        { error: "poolId query param is required (e.g. ?poolId=5)" },
        { status: 400 },
      );
    }
    const action = poolActionId(poolId);

    const sig = signRequest({ signingKeyHex, action });

    return Response.json({
      rp_context: {
        rp_id: rpId,
        nonce: sig.nonce,
        created_at: sig.createdAt,
        expires_at: sig.expiresAt,
        signature: sig.sig,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build rp_context";
    return Response.json({ error: message }, { status: 500 });
  }
}
