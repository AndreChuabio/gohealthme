// GET /api/whoop/callback?code=...&state=nonce:address
// OAuth redirect target registered with WHOOP. Exchanges the code for
// tokens, persists them keyed by wallet address (.data/whoop-tokens.json),
// then redirects back to the app with ?whoop=connected.

import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { exchangeCode, saveTokensForAddress } from "@/lib/server/whoop";
import { errorMessage, jsonError } from "@/lib/server/http";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    const oauthError = params.get("error");
    if (oauthError !== null) {
      return jsonError(
        400,
        `WHOOP authorization failed: ${oauthError} ${params.get("error_description") ?? ""}`.trim(),
      );
    }

    const code = params.get("code");
    const state = params.get("state");
    if (code === null || state === null) {
      return jsonError(400, "Missing code or state in WHOOP callback");
    }

    const [nonce, address] = state.split(":");
    if (nonce === undefined || address === undefined || !isAddress(address)) {
      return jsonError(400, "Malformed OAuth state");
    }
    const cookieNonce = request.cookies.get("whoop_oauth_nonce")?.value;
    if (cookieNonce !== nonce) {
      return jsonError(
        403,
        "OAuth state mismatch. Restart the flow at /api/whoop/login",
      );
    }

    const tokens = await exchangeCode(code);
    await saveTokensForAddress(address, tokens);

    const redirect = new URL("/", request.nextUrl.origin);
    redirect.searchParams.set("whoop", "connected");
    redirect.searchParams.set("address", address);
    const response = NextResponse.redirect(redirect);
    response.cookies.delete("whoop_oauth_nonce");
    return response;
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
