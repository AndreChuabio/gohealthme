// GET /api/whoop/login?address=0x...
// Starts the WHOOP OAuth flow. Binds the wallet address into the OAuth
// state (random nonce + address) and stores the nonce in an httpOnly
// cookie so the callback can verify both CSRF and address.

import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { buildAuthorizeUrl } from "@/lib/server/whoop";
import { errorMessage, jsonError } from "@/lib/server/http";

export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get("address");
    if (address === null || !isAddress(address)) {
      return jsonError(400, "Query param address must be a valid 0x address");
    }

    const nonce = randomBytes(16).toString("hex");
    // WHOOP requires state to be at least 8 characters; this is 32 + 1 + 42.
    const state = `${nonce}:${address}`;

    const response = NextResponse.redirect(buildAuthorizeUrl(state));
    response.cookies.set("whoop_oauth_nonce", nonce, {
      httpOnly: true,
      sameSite: "lax",
      path: "/api/whoop",
      maxAge: 600,
    });
    return response;
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
