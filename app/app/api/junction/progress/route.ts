// GET /api/junction/progress?address=0x...&threshold=75&goalDays=7
// Returns the address's current streak from connected Junction data:
//   { connected, metric, streakDays, targetDays, lastSync }
// connected=false (rather than 404) when no provider is linked yet, so the
// dashboard can show a "connect your wearable" prompt.

import { type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getProgress, isConnected } from "@/lib/server/junction";
import { errorMessage, jsonError } from "@/lib/server/http";

function parsePositiveInt(value: string | null, fallback: number): number | null {
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

    if (!(await isConnected(address))) {
      return Response.json({
        connected: false,
        metric: null,
        streakDays: null,
        targetDays: goalDays,
        lastSync: null,
      });
    }

    const progress = await getProgress(address, threshold, goalDays);
    return Response.json({
      connected: true,
      metric: `Sleep score ≥ ${threshold}`,
      streakDays: progress.streakDays,
      targetDays: goalDays,
      lastSync: progress.days[0]?.date ?? null,
    });
  } catch (err) {
    return jsonError(502, errorMessage(err));
  }
}
