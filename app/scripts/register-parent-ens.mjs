// Registers the parent ENS name (ENS_PARENT_NAME) on Sepolia, wrapped, owned by
// ENS_OWNER_PRIVATE_KEY — so the app's setSubnodeRecord subname flow works.
//
// Commit-reveal-wrap via the Sepolia ETHRegistrarController (auto-wraps into
// NameWrapper). Run from the app/ dir so viem resolves:
//   export $(grep -E '^(ENS_OWNER_PRIVATE_KEY|ENS_PARENT_NAME|SEPOLIA_RPC_URL)=' ../.env | xargs)
//   node scripts/register-parent-ens.mjs
//
// Takes ~75s (60s mandatory commit age). Idempotent-ish: aborts if the name is
// already taken.

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { randomBytes } from "node:crypto";

// Legacy ETHRegistrarController authorized on the legacy NameWrapper (the one our
// app/lib/server/ens.ts setSubnodeRecord flow uses). The newer 0xfb3c... controller is
// ENS v2 and is NOT a controller on this NameWrapper, so its register() reverts.
const CONTROLLER = "0xFED6a969AaA60E4961FCD3EBF1A2e8913ac65B72";
const RESOLVER = "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
const DURATION = 31536000n; // 1 year
const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const name = (process.env.ENS_PARENT_NAME || "").trim();
const pk = (process.env.ENS_OWNER_PRIVATE_KEY || "").trim();
if (!name.endsWith(".eth")) throw new Error(`ENS_PARENT_NAME must be a .eth name, got "${name}"`);
if (!pk) throw new Error("ENS_OWNER_PRIVATE_KEY missing");
const label = name.slice(0, -4);
if (label.includes(".")) throw new Error("Parent must be a 2LD (e.g. gohealthme.eth)");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

// Legacy controller: positional 8-arg makeCommitment/register (verified by free eth_call probe).
const COMMIT_INPUTS = [
  { name: "name", type: "string" },
  { name: "owner", type: "address" },
  { name: "duration", type: "uint256" },
  { name: "secret", type: "bytes32" },
  { name: "resolver", type: "address" },
  { name: "data", type: "bytes[]" },
  { name: "reverseRecord", type: "bool" },
  { name: "ownerControlledFuses", type: "uint16" },
];
const ABI = [
  { type: "function", name: "available", stateMutability: "view", inputs: [{ name: "name", type: "string" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "rentPrice", stateMutability: "view", inputs: [{ name: "name", type: "string" }, { name: "duration", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "base", type: "uint256" }, { name: "premium", type: "uint256" }] }] },
  { type: "function", name: "makeCommitment", stateMutability: "pure", inputs: COMMIT_INPUTS, outputs: [{ type: "bytes32" }] },
  { type: "function", name: "commit", stateMutability: "nonpayable", inputs: [{ name: "commitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "register", stateMutability: "payable", inputs: COMMIT_INPUTS, outputs: [] },
  // custom errors so reverts decode to a name instead of bare 0x
  { type: "error", name: "CommitmentNotFound", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "CommitmentTooNew", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "CommitmentTooOld", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "DurationTooShort", inputs: [{ type: "uint256" }] },
  { type: "error", name: "InsufficientValue", inputs: [] },
  { type: "error", name: "NameNotAvailable", inputs: [{ type: "string" }] },
  { type: "error", name: "ResolverRequiredForReverseRecord", inputs: [] },
  { type: "error", name: "ResolverRequiredWhenDataSupplied", inputs: [] },
  { type: "error", name: "UnexpiredCommitmentExists", inputs: [{ type: "bytes32" }] },
];

const read = (fn, args) => pub.readContract({ address: CONTROLLER, abi: ABI, functionName: fn, args });

console.log(`Registering ${name} on Sepolia, owner ${account.address}`);

const bal = await pub.getBalance({ address: account.address });
console.log(`  owner balance: ${bal} wei`);

if (!(await read("available", [label]))) throw new Error(`${name} is NOT available on Sepolia — pick another ENS_PARENT_NAME`);
console.log(`  ${name} is available`);

const price = await read("rentPrice", [label, DURATION]);
const cost = price.base + price.premium;
const value = cost + cost / 3n; // +33% slippage buffer
console.log(`  rent ${cost} wei, sending ${value} wei`);

const secret = `0x${randomBytes(32).toString("hex")}`;
// Positional args, identical for makeCommitment and register. resolver=0/data=[] keeps it
// to a bare wrapped registration; subnames set their own resolver later.
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const regArgs = [label, account.address, DURATION, secret, ZERO_ADDR, [], false, 0];

const commitment = await read("makeCommitment", regArgs);
console.log(`  commitment ${commitment}`);

const commitTx = await wallet.writeContract({ address: CONTROLLER, abi: ABI, functionName: "commit", args: [commitment] });
console.log(`  commit tx ${commitTx} — waiting for receipt`);
await pub.waitForTransactionReceipt({ hash: commitTx });

console.log("  waiting 65s for MIN_COMMITMENT_AGE...");
await new Promise((r) => setTimeout(r, 65000));

// Simulate first via eth_call (returns revert data that estimateGas strips on some RPCs).
try {
  await pub.simulateContract({ address: CONTROLLER, abi: ABI, functionName: "register", args: regArgs, value, account });
  console.log("  simulate OK");
} catch (e) {
  console.log("  SIMULATE REVERT:");
  console.log("   shortMessage:", e.shortMessage);
  const revert = e.walk?.((x) => x?.name === "ContractFunctionRevertedError");
  if (revert) {
    console.log("   errorName:", revert.data?.errorName ?? "(undecoded)");
    console.log("   errorArgs:", JSON.stringify(revert.data?.args ?? null));
    console.log("   rawData:", revert.raw ?? revert.signature ?? "(none)");
  }
  throw e;
}

const regTx = await wallet.writeContract({ address: CONTROLLER, abi: ABI, functionName: "register", args: regArgs, value });
console.log(`  register tx ${regTx} — waiting for receipt`);
const rcpt = await pub.waitForTransactionReceipt({ hash: regTx });

if (rcpt.status !== "success") throw new Error("register tx reverted");
const stillAvail = await read("available", [label]);
console.log("");
console.log(stillAvail ? "WARN: name still shows available — investigate" : `SUCCESS: ${name} registered + wrapped, owned by ${account.address}`);
console.log(`  https://sepolia.app.ens.domains/${name}`);
