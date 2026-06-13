// ENS subname registry on Sepolia (server only).
//
// Verified from live ENS docs (docs.ens.domains, fetched Jun 12 2026):
//   - NameWrapper.setSubnodeRecord(bytes32 parentNode, string label,
//       address owner, address resolver, uint64 ttl, uint32 fuses,
//       uint64 expiry) creates a wrapped subname in one call.
//   - Sepolia deployments: NameWrapper 0x0635513f179D50A207757E05759CbD106d7dFcE8,
//     PublicResolver 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5,
//     Registry 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e.
//   - PublicResolver.setText(bytes32 node, string key, string value).
//
// Assumed (not explicitly verified in docs, standard NameWrapper behavior):
//   - fuses=0, expiry=0, ttl=0 is valid for a subname with no fuses burned.
//   - PublicResolver authorises the wrapped-name owner for setText by
//     resolving registry owner -> NameWrapper -> NameWrapper.ownerOf(node).
//     This is why subnames are created with owner = our ENS signer: the
//     same key can then write text records. TODO post-hackathon: transfer
//     user subnames to the user (NameWrapper is ERC-1155) once achievement
//     records are written via a signed-update flow instead.
//
// The parent name (ENS_PARENT_NAME, e.g. gohealth.eth) must already be
// registered on Sepolia and WRAPPED, with ENS_OWNER_PRIVATE_KEY as its
// NameWrapper owner. setSubnodeRecord reverts otherwise.
//
// No hard-coded pool values anywhere: judges check for real resolution.
// Everything the frontend shows must come back out of these text records
// via resolution, not from a local constant.

import {
  createPublicClient,
  createWalletClient,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { namehash, normalize } from "viem/ens";
import { optionalEnv, requireEnv } from "@/lib/server/env";

const NAME_WRAPPER: Address = "0x0635513f179D50A207757E05759CbD106d7dFcE8";
const PUBLIC_RESOLVER: Address = "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
const ENS_REGISTRY: Address = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

const NAME_WRAPPER_ABI = [
  {
    type: "function",
    name: "setSubnodeRecord",
    stateMutability: "nonpayable",
    inputs: [
      { name: "parentNode", type: "bytes32" },
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "resolver", type: "address" },
      { name: "ttl", type: "uint64" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "node", type: "bytes32" }],
  },
] as const;

const RESOLVER_ABI = [
  {
    type: "function",
    name: "setText",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export interface SubnameResult {
  name: string;
  node: Hex;
  created: boolean;
  txHashes: Hex[];
}

function clients() {
  const rpcUrl = optionalEnv(
    "SEPOLIA_RPC_URL",
    sepolia.rpcUrls.default.http[0],
  );
  const pk = requireEnv("ENS_OWNER_PRIVATE_KEY");
  const account = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex,
  );
  const transport = http(rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain: sepolia, transport }),
    wallet: createWalletClient({ account, chain: sepolia, transport }),
  };
}

/**
 * Create (or update) a subname under ENS_PARENT_NAME and write text
 * records to it. Idempotent: if the subname node already has an owner in
 * the registry, creation is skipped and only the text records are written.
 * Sepolia writes are sequential on purpose; nonce races on the single
 * owner key are a bigger hackathon risk than the extra seconds.
 */
export async function createSubnameWithRecords(
  label: string,
  texts: Record<string, string>,
): Promise<SubnameResult> {
  const parent = normalize(requireEnv("ENS_PARENT_NAME"));
  const normalizedLabel = normalize(label);
  const fullName = `${normalizedLabel}.${parent}`;
  const parentNode = namehash(parent);
  const node = namehash(fullName);
  const { account, publicClient, wallet } = clients();
  const txHashes: Hex[] = [];

  const currentOwner = await publicClient.readContract({
    address: ENS_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "owner",
    args: [node],
  });
  const exists = currentOwner !== zeroAddress;

  if (!exists) {
    const { request } = await publicClient.simulateContract({
      account,
      address: NAME_WRAPPER,
      abi: NAME_WRAPPER_ABI,
      functionName: "setSubnodeRecord",
      args: [
        parentNode,
        normalizedLabel,
        account.address, // owner stays with the registry signer, see header
        PUBLIC_RESOLVER,
        0n, // ttl
        0, // fuses: none burned
        0n, // expiry: none (no fuses require one)
      ],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`setSubnodeRecord for ${fullName} reverted (${hash})`);
    }
    txHashes.push(hash);
  }

  for (const [key, value] of Object.entries(texts)) {
    const { request } = await publicClient.simulateContract({
      account,
      address: PUBLIC_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "setText",
      args: [node, key, value],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`setText(${key}) for ${fullName} reverted (${hash})`);
    }
    txHashes.push(hash);
  }

  return { name: fullName, node, created: !exists, txHashes };
}
