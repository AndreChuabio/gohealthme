// POST /api/ens/register-pool
// Body: { poolId, goalSpec, entryFee, period, label? }
// Creates <label>.<ENS_PARENT_NAME> on Sepolia via NameWrapper and writes
// the pool's terms as resolvable text records:
//   description       = goalSpec
//   gohealth.entryFee = entryFee (USDC, human units as sent)
//   gohealth.period   = period
//   gohealth.pool     = <HEALTH_POOLS_ADDRESS>:<poolId>
// Returns: { ok: true, name, node, created, txHashes }
//
// The frontend's pool discovery resolves these records back out of ENS;
// nothing is hard-coded (ENS judges check for real resolution).

import { createSubnameWithRecords } from "@/lib/server/ens";
import { requireEnv } from "@/lib/server/env";
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

    const { poolId, goalSpec, entryFee, period } = body;
    if (typeof poolId !== "string" && typeof poolId !== "number") {
      return jsonError(400, "poolId must be a string or number");
    }
    if (typeof goalSpec !== "string" || goalSpec.length === 0) {
      return jsonError(400, "goalSpec must be a non-empty string");
    }
    if (typeof entryFee !== "string" && typeof entryFee !== "number") {
      return jsonError(400, "entryFee must be a string or number");
    }
    if (typeof period !== "string" && typeof period !== "number") {
      return jsonError(400, "period must be a string or number");
    }

    const label =
      typeof body.label === "string" && body.label.length > 0
        ? body.label.toLowerCase()
        : `pool-${String(poolId)}`;
    if (!LABEL_RE.test(label)) {
      return jsonError(
        400,
        "label must be 1-63 chars of lowercase a-z, 0-9, or hyphen",
      );
    }

    const healthPools = requireEnv("HEALTH_POOLS_ADDRESS");
    const result = await createSubnameWithRecords(label, {
      description: goalSpec,
      "gohealth.entryFee": String(entryFee),
      "gohealth.period": String(period),
      "gohealth.pool": `${healthPools}:${String(poolId)}`,
    });

    return Response.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
