// Server-side Unlink clients for GoHealthMe private payouts (canary SDK).
import {
  createUnlink,
  unlinkAccount,
  unlinkEvm,
  type UnlinkClient,
} from "@unlink-xyz/sdk";
import {
  createWalletClient,
  createPublicClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireEnv, optionalEnv } from "@/lib/server/env";

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

function engine() {
  return {
    engineUrl: requireEnv("UNLINK_ENGINE_URL"),
    apiKey: requireEnv("UNLINK_API_KEY"),
  };
}

/** Deterministic, stable Unlink accountIndex for a participant EVM address. */
export function participantAccountIndex(address: string): number {
  const hex = address.toLowerCase().replace(/^0x/, "").slice(0, 8) || "0";
  return Number(BigInt("0x" + hex) % 2147483648n); // < 2^31
}

/** Treasury client: an Unlink account funded by an EVM wallet on Arc (for deposit Permit2). */
export function treasuryUnlinkClient(): UnlinkClient {
  const { engineUrl, apiKey } = engine();
  const pk = requireEnv("UNLINK_TREASURY_PRIVATE_KEY");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
  const chain = arcChain();
  const walletClient = createWalletClient({ account, chain, transport: http() });
  const publicClient = createPublicClient({ chain, transport: http() });
  return createUnlink({
    engineUrl,
    apiKey,
    account: unlinkAccount.fromMnemonic({
      mnemonic: requireEnv("UNLINK_TREASURY_MNEMONIC"),
    }),
    evm: unlinkEvm.fromViem({ walletClient, publicClient }),
  });
}

/** Participant client: shielded-side only (withdraw/getAddress/getBalances) — no EVM needed. */
export function participantUnlinkClient(address: string): UnlinkClient {
  const { engineUrl, apiKey } = engine();
  return createUnlink({
    engineUrl,
    apiKey,
    account: unlinkAccount.fromMnemonic({
      mnemonic: requireEnv("UNLINK_USER_MASTER_MNEMONIC"),
      accountIndex: participantAccountIndex(address),
    }),
  });
}
