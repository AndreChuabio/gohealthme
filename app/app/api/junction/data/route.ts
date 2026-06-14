// GET /api/junction/data?address=0x...&days=7
// Recent per-day sleep + activity from the linked provider, for the dashboard
// demo display. { connected, sleep[], activity[] }.

import { type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getRecent, isConnected } from "@/lib/server/junction";
import { errorMessage, jsonError } from "@/lib/server/http";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const address = params.get("address");
    if (address === null || !isAddress(address)) {
      return jsonError(400, "Query param address must be a valid 0x address");
    }
    const daysRaw = Number(params.get("days") ?? 7);
    const days = Number.isInteger(daysRaw) && daysRaw > 0 && daysRaw <= 30 ? daysRaw : 7;

    if (!(await isConnected(address))) {
      return Response.json({ connected: false, sleep: [], activity: [] });
    }
    const recent = await getRecent(address, days);
    return Response.json({ connected: true, ...recent });
  } catch (err) {
    return jsonError(502, errorMessage(err));
  }
}
