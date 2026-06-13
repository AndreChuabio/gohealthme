// Server-side Unlink admin handle + auth route handlers for 0.3.0 SDK.
// The admin handle issues short-lived capability tokens and registers users.
// Auth routes are mounted at /api/unlink/authorization-token and /api/unlink/register.
import {
  createUnlinkAdmin,
  createUnlinkAuthRoutes,
  type UnlinkAuthRouteHandlers,
} from "@unlink-xyz/sdk/admin";
import { requireEnv, optionalEnv } from "@/lib/server/env";

function unlinkAdmin() {
  return createUnlinkAdmin({
    environment: optionalEnv("UNLINK_ENVIRONMENT", "arc-testnet"),
    // Optional URL override: if UNLINK_ENGINE_URL is set it takes precedence.
    ...(process.env.UNLINK_ENGINE_URL
      ? { engineUrl: process.env.UNLINK_ENGINE_URL }
      : {}),
    apiKey: requireEnv("UNLINK_API_KEY"),
  });
}

export function unlinkAuthRoutes(): UnlinkAuthRouteHandlers {
  const admin = unlinkAdmin();
  return createUnlinkAuthRoutes({
    admin,
    // Permissive authenticator: returns an empty session object.
    // Access is implicitly scoped by appId + engine environment.
    authenticate: async (_request: Request) => ({}),
    // Allow any registered address — this demo gates access via World ID at
    // the payout layer, not at the token-issuance layer.
    authorizeUnlinkAddress: async (_params) => true,
    onRegister: async (_params) => {
      // Optional: persist the app-user → Unlink-address mapping here.
      // We do this in the payout route via linkUnlinkAddress instead.
    },
  });
}

export { unlinkAdmin };
