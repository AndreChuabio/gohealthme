// Dynamic EvmNetwork descriptor for Arc testnet, passed via
// DynamicContextProvider overrides.evmNetworks.
// Shape verified against @dynamic-labs/types EvmNetwork (v4.88.6):
//   EvmNetwork = Omit<GenericNetwork, 'chainId'> & { chainId: number; ... }
//   GenericNetwork = Omit<NetworkConfiguration, 'chainId'|'networkId'|'shortName'|'chain'>
//                   & { chainId: number|string; networkId: number|string; ... }
// Required fields (all non-optional in NetworkConfiguration and not omitted):
//   name, nativeCurrency, rpcUrls, blockExplorerUrls, iconUrls, chainId, networkId
import type { EvmNetwork } from "@dynamic-labs/types";

export const arcEvmNetwork: EvmNetwork = {
  chainId: 5042002,
  networkId: 5042002,
  name: "Arc Testnet",
  iconUrls: [],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};
