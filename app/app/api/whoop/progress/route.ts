// GET /api/whoop/progress?address=0x...&threshold=75&goalDays=7
// Returns the address's current sleep streak from WHOOP:
//   { streakDays, lastNight, qualified, baselineWeekAvg, days[] }
// 404 when the address has not connected WHOOP yet.

import { type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getProgress, getTokensForAddress } from "@/lib/server/whoop";
import { errorMessage, jsonError } from "@/lib/server/http";

function parsePositiveInt(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 100) return null;
  return n;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const address = params.get("address");
    if (address === null || !isAddress(address)) {
      return jsonError(400, "Query param address must be a valid 0x address");
    }
    const threshold = parsePositiveInt(params.get("threshold"), 75);
    const goalDays = parsePositiveInt(params.get("goalDays"), 7);
    if (threshold === null || goalDays === null) {
      return jsonError(400, "threshold and goalDays must be integers in 1..100");
    }

    const tokens = await getTokensForAddress(address);
    if (tokens === null) {
      return jsonError(
        404,
        `No WHOOP connection for ${address}. Start at /api/whoop/login?address=${address}`,
      );
    }

    const progress = await getProgress(address, threshold, goalDays);
    return Response.json(progress);
  } catch (err) {
    return jsonError(502, errorMessage(err));
  }
}
