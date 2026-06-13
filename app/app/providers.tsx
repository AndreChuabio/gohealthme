"use client";

import { useState, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, fallback, http } from "wagmi";
import { arcTestnet, sepolia } from "@/lib/chains";

const wagmiConfig = createConfig({
  chains: [arcTestnet, sepolia],
  transports: {
    [arcTestnet.id]: fallback([
      http("https://rpc.testnet.arc.network"),
      http("https://rpc.blockdaemon.testnet.arc.network"),
      http("https://rpc.drpc.testnet.arc.network"),
    ]),
    [sepolia.id]: http(),
  },
  connectors: [],
  ssr: true,
});

function PrivyMissingBanner() {
  return (
    <div className="bg-amber-950 border-b border-amber-700 px-4 py-2 text-sm text-amber-200">
      Privy is not configured. Set NEXT_PUBLIC_PRIVY_APP_ID to enable sign-in
      and embedded wallets.
    </div>
  );
}

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

  const inner = (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
    </QueryClientProvider>
  );

  if (privyAppId === "") {
    return (
      <>
        <PrivyMissingBanner />
        {inner}
      </>
    );
  }

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#34d399",
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet, sepolia],
      }}
    >
      {inner}
    </PrivyProvider>
  );
}
