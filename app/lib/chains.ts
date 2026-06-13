import { defineChain } from "viem";
import { sepolia } from "viem/chains";

/**
 * Arc testnet. Gas is paid in native USDC (18 decimals at the protocol
 * level); the canonical ERC-20 interface used for pool accounting lives at
 * 0x3600...0000 with 6 decimals.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.testnet.arc.network",
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.drpc.testnet.arc.network",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export { sepolia };

export function arcTxUrl(txHash: string): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}

export function arcAddressUrl(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}
