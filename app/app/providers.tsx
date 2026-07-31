"use client";

import { useState, type ReactNode } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, fallback, http } from "wagmi";
import { arcTestnet } from "@/lib/chains";
import { arcEvmNetwork } from "@/lib/dynamic";

// Arc-only. Sepolia was removed with the dropped ENS work — its unreachable
// default RPC was timing out in the wallet connector (UnknownRpcError).
const wagmiConfig = createConfig({
  // Without this, wagmi auto-creates its own injected MetaMask connector
  // (EIP-6963 discovery) that races Dynamic's connect: it flips wagmi to
  // "connected" before Dynamic finishes binding, SyncDynamicWagmi sees no
  // Dynamic wallet and disconnects wagmi, and wagmi's injected disconnect
  // fires wallet_revokePermissions — revoking the approval the user just
  // gave. MetaMask >=13.41 honors that revoke, so sign-in always failed.
  // Dynamic must stay the only wallet lifecycle owner.
  multiInjectedProviderDiscovery: false,
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: fallback([
      http("https://rpc.testnet.arc.network"),
      http("https://rpc.blockdaemon.testnet.arc.network"),
      http("https://rpc.drpc.testnet.arc.network"),
    ]),
  },
  connectors: [],
  ssr: true,
});

function DynamicMissingBanner() {
  return (
    <div className="bg-amber-950 border-b border-amber-700 px-4 py-2 text-sm text-amber-200">
      Dynamic is not configured. Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to
      enable sign-in and embedded wallets.
    </div>
  );
}

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 2, refetchOnWindowFocus: false },
        },
      }),
  );

  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "";
  if (environmentId === "") {
    return <DynamicMissingBanner />;
  }

  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        // connect-only skips the SIWE ownership signature on login (the wallet
        // sign step that threw UserRejectedRequestError 4001 in prod). The app
        // only gates on useIsLoggedIn()/primaryWallet and Unlink derives its
        // own signature separately, so no login signature is needed.
        initialAuthenticationMode: "connect-only",
        walletConnectors: [EthereumWalletConnectors],
        // The metamask-evm connector before 4.6.11 connected the wallet but
        // never bound it into Dynamic state in connect-only mode (the old
        // useMetamaskSdk:false workaround stopped covering it once MetaMask
        // 13.41 shipped). SDK 4.95.1 pins the fixed connector, which delegates
        // to the injected EIP-6963 provider when the extension is installed.
        overrides: { evmNetworks: [arcEvmNetwork] },
        // Don't show Dynamic's per-transaction confirmation modal for the
        // embedded (email) wallet — email-login users sign without an extra
        // popup each time. (External wallets like MetaMask still show their
        // own native prompt, which Dynamic can't suppress.)
        transactionConfirmation: { required: false },
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
