// GET /api/world/rp-context
//
// World ID 4.0 relying-party context. The IDKitRequestWidget needs a signed
// rp_context before it can request a proof. We sign it server-side with the RP
// signer key (WORLD_SIGNER_PRIVATE_KEY) using @worldcoin/idkit-server, scoped to
// our action, and return the rp_context the widget expects.
//
// Required env:
//   WORLD_SIGNER_PRIVATE_KEY  the RP signer key generated in the World dev portal
//   WORLD_RP_ID               the registered RP ID (format rp_...) from the
//                             "World ID 4.0" tab (NOT the app_ id)
// Optional:
//   WORLD_ACTION_ID           the incognito action (default "join-pool")

import { signRequest } from "@worldcoin/idkit-server";
import { optionalEnv, requireEnv } from "@/lib/server/env";

export async function GET() {
  try {
    const signingKeyHex = requireEnv("WORLD_SIGNER_PRIVATE_KEY").replace(/^0x/, "");
    const rpId = requireEnv("WORLD_RP_ID");
    const action = optionalEnv("WORLD_ACTION_ID", "join-pool");

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
