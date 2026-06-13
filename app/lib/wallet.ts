"use client";

import { useCallback } from "react";
import {
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import {
  createWalletClient,
  custom,
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
  wallet: ConnectedWallet | null;
  login: () => void;
  logout: () => Promise<void>;
  getArcWalletClient: () => Promise<ArcWalletClient>;
}

function pickWallet(wallets: ConnectedWallet[]): ConnectedWallet | null {
  if (wallets.length === 0) return null;
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  return embedded ?? wallets[0];
}

/**
 * Privy-backed wallet access. Prefers the embedded wallet, switches it to
 * Arc testnet, and wraps its EIP-1193 provider in a viem wallet client.
 */
export function useEmbeddedWallet(): EmbeddedWalletState {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const wallet = pickWallet(wallets);
  const address =
    wallet !== null && /^0x[0-9a-fA-F]{40}$/.test(wallet.address)
      ? (wallet.address as Address)
      : null;

  const getArcWalletClient = useCallback(async (): Promise<ArcWalletClient> => {
    if (wallet === null || address === null) {
      throw new Error("No wallet connected. Sign in first.");
    }
    await wallet.switchChain(arcTestnet.id);
    const provider = await wallet.getEthereumProvider();
    return createWalletClient({
      account: address,
      chain: arcTestnet,
      transport: custom(provider),
    });
  }, [wallet, address]);

  return {
    ready,
    authenticated,
    address,
    wallet,
    login,
    logout,
    getArcWalletClient,
  };
}
