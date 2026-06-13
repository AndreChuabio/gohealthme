"use client";

// Client-side non-custodial Unlink account derivation.
// Each user's Unlink identity is derived deterministically from their own
// wallet signature — no server holds their private keys.
import {
  account as unlinkAccountNs,
  createUnlinkClient,
  type UnlinkClient,
} from "@unlink-xyz/sdk/browser";
import type { ArcWalletClient } from "@/lib/wallet";

/** ARC Testnet chain id — must match the value used in account derivation. */
const ARC_CHAIN_ID = 5042002;

/**
 * Fixed message signed by the user's wallet to derive their Unlink seed.
 * MUST NOT change once deployed — changing it derives a different Unlink
 * address and the user loses access to any existing shielded balance.
 */
const UNLINK_DERIVATION_MESSAGE = "GoHealthMe Unlink account v1";

/** Re-exported so browser components don't need to import from server files. */
export const ARC_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000";

export interface DerivedUnlinkAccount {
  client: UnlinkClient;
  unlinkAddress: string;
}

/**
 * Derive a non-custodial Unlink account from the user's viem WalletClient.
 *
 * 1. Signs a fixed deterministic message (no pop-up storm on re-derive).
 * 2. Derives the Unlink account from the signature (synchronous, pure).
 * 3. Constructs a browser UnlinkClient pointing at our auth routes.
 * 4. Registers the account with the engine (idempotent — safe to call again).
 * 5. Returns the client + the bech32m unlink address for the payout POST.
 */
export async function deriveUnlinkAccount(
  walletClient: ArcWalletClient,
): Promise<DerivedUnlinkAccount> {
  const appId = process.env.NEXT_PUBLIC_UNLINK_APP_ID;
  if (!appId) {
    throw new Error(
      "NEXT_PUBLIC_UNLINK_APP_ID is not set. Add it to app/.env.local.",
    );
  }

  // Step 1: sign the derivation message with the user's own wallet.
  const signature = await walletClient.signMessage({
    account: walletClient.account,
    message: UNLINK_DERIVATION_MESSAGE,
  });

  // Step 2: derive the Unlink account (synchronous).
  const localAccount = unlinkAccountNs.fromEthereumSignature({
    signature,
    appId,
    chainId: ARC_CHAIN_ID,
  });

  // Step 3: construct the browser client.
  // Uses DEFAULT_AUTHORIZATION_TOKEN_URL (/api/unlink/authorization-token) and
  // DEFAULT_REGISTER_URL (/api/unlink/register) automatically.
  const client = createUnlinkClient({
    environment: "arc-testnet",
    account: localAccount,
  });

  // Step 4: register (idempotent — safe to call on every page load).
  await client.ensureRegistered();

  // Step 5: resolve the user's bech32m Unlink address.
  const unlinkAddress = await client.getAddress();

  return { client, unlinkAddress };
}
