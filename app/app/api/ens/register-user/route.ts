// POST /api/ens/register-user
// Body: { address, label?, poolId? }
// Mints a user subname under ENS_PARENT_NAME on Sepolia with initial
// text records:
//   gohealth.address = wallet address
//   gohealth.joined  = ISO timestamp
//   gohealth.pools   = poolId (when provided)
// Returns: { ok: true, name, node, created, txHashes }
//
// Subname ownership stays with the registry signer for the hackathon so
// the oracle key can append achievement records later; see lib/server/ens.ts
// header for the post-hackathon transfer plan.

import { isAddress } from "viem";
import { createSubnameWithRecords } from "@/lib/server/ens";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

const LABEL_RE = /^[a-z0-9-]{1,63}$/;

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { address, poolId } = body;
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }

    const label =
      typeof body.label === "string" && body.label.length > 0
        ? body.label.toLowerCase()
        : `u-${address.slice(2, 10).toLowerCase()}`;
    if (!LABEL_RE.test(label)) {
      return jsonError(
        400,
        "label must be 1-63 chars of lowercase a-z, 0-9, or hyphen",
      );
    }

    const texts: Record<string, string> = {
      "gohealth.address": address,
      "gohealth.joined": new Date().toISOString(),
    };
    if (typeof poolId === "string" || typeof poolId === "number") {
      texts["gohealth.pools"] = String(poolId);
    }

    const result = await createSubnameWithRecords(label, texts);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
