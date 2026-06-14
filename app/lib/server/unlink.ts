// Server-side Unlink treasury client for GoHealthMe private payouts (0.3.0 SDK).
// Only the treasury remains server-side; participant accounts are now derived
// client-side from the user's own wallet signature (non-custodial).
import {
  createUnlinkClient,
  account,
  evm,
  type UnlinkClient,
} from "@unlink-xyz/sdk/client";
import {
  createWalletClient,
  createPublicClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireEnv, optionalEnv } from "@/lib/server/env";
import { unlinkAdmin, unlinkEndpoint } from "@/lib/server/unlink-admin";

export const ARC_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000";

function arcChain() {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
  return defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
    },
  });
}

/**
 * Treasury client: uses the platform's mnemonic-derived Unlink account and
 * its EVM wallet (for Permit2 deposit signatures). Deposits into the shielded
 * pool then privately transfers to the user's wallet-derived Unlink address.
 *
 * The authorization token provider calls the admin directly (server-to-server),
 * so no browser round-trip is needed.
 */
export function treasuryUnlinkClient(): UnlinkClient {
  const pk = requireEnv("UNLINK_TREASURY_PRIVATE_KEY");
  const evmAccount = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex,
  );
  const chain = arcChain();
  const walletClient = createWalletClient({
    account: evmAccount,
    chain,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain, transport: http() });

  const treasuryAccount = account.fromMnemonic({
    mnemonic: requireEnv("UNLINK_TREASURY_MNEMONIC"),
  });

  const admin = unlinkAdmin();

  return createUnlinkClient({
    ...unlinkEndpoint(),
    account: treasuryAccount,
    evm: evm.fromViem({ walletClient, publicClient }),
    // Server/custodial register hook: wire directly to the admin so
    // `ensureRegistered()` registers the treasury under THIS project. Without
    // it the treasury address "does not belong to this tenant/project" and the
    // engine refuses to issue it an authorization token ("token provider failed").
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: async (ctx) =>
        admin.authorizationTokens.issue({ unlinkAddress: ctx.unlinkAddress }),
    },
  });
}
