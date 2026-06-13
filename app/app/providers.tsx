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
        walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: [arcEvmNetwork] },
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
