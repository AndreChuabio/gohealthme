"use client";

import { useCallback } from "react";
import { useDynamicContext, useIsLoggedIn } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import {
  type Account,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
} from "viem";
import { arcTestnet } from "@/lib/chains";

export type ArcWalletClient = WalletClient<Transport, Chain, Account>;

export interface EmbeddedWalletState {
  ready: boolean;
  authenticated: boolean;
  address: Address | null;
  login: () => void;
  logout: () => Promise<void>;
  getArcWalletClient: () => Promise<ArcWalletClient>;
}

/**
 * Dynamic-backed wallet access. Prefers the primary wallet, switches it to
 * Arc testnet, and returns a viem wallet client.
 *
 * Public interface is identical to the previous wallet hook so all
 * consumers (JoinPool, FundPool, BackGoal, CreatePool, Header, useUsdcDeposit)
 * are untouched. The `wallet` field from the old interface was confirmed
 * unused by consumers (grep -rn ".wallet" app/components app/lib returned 0 hits).
 */
export function useEmbeddedWallet(): EmbeddedWalletState {
  const { sdkHasLoaded, primaryWallet, setShowAuthFlow, handleLogOut } =
    useDynamicContext();
  const isLoggedIn = useIsLoggedIn();

  const address =
    primaryWallet !== null && /^0x[0-9a-fA-F]{40}$/.test(primaryWallet.address)
      ? (primaryWallet.address as Address)
      : null;

  const getArcWalletClient = useCallback(async (): Promise<ArcWalletClient> => {
    if (primaryWallet === null || !isEthereumWallet(primaryWallet)) {
      throw new Error("No EVM wallet connected. Sign in first.");
    }
    await primaryWallet.switchNetwork(arcTestnet.id);
    const walletClient = await primaryWallet.getWalletClient();
    return walletClient as ArcWalletClient;
  }, [primaryWallet]);

  return {
    ready: sdkHasLoaded,
    authenticated: isLoggedIn,
    address,
    login: () => setShowAuthFlow(true),
    logout: handleLogOut,
    getArcWalletClient,
  };
}
