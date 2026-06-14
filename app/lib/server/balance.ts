// GoHealthMe balance ledger (server-side, hackathon-grade).
//
// A per-address uUSDC ledger persisted as a single JSON file in os.tmpdir()
// (via the store helpers, which write under the OS temp dir to survive the
// Vercel read-only filesystem). uUSDC means integer micro-USDC with 6 decimals:
// 2 USDC == 2_000_000n.
//
// Flow this backs:
//   - A confirmed Blink top-up on Base Sepolia credits the address here.
//   - Joining/funding/backing a pool later debits this balance while the Arc
//     treasury sponsors the on-chain tx (that integration lives elsewhere).
//
// Idempotency: credit and debit are keyed by a ref (the Blink tx hash for a
// credit). A ref is applied at most once per address, so retried webhooks or
// double-clicks never double-count. bigint amounts are stored as strings.
//
// TODO post-hackathon: replace the JSON file with a real store (Redis/Postgres)
// and verify the Base Sepolia tx receipt before crediting.

import type { Address } from "viem";
import { readJson, writeJson } from "@/lib/server/store";

const BALANCE_FILE = "balances.json";

interface AddressEntry {
  // Stringified bigint of the current uUSDC balance.
  balanceUusdc: string;
  // Refs already applied to this address (credit or debit), for idempotency.
  applied: string[];
}

// Map of lowercased address -> entry.
type BalanceStore = Record<string, AddressEntry>;

export interface BalanceMutation {
  balanceUusdc: bigint;
  applied: boolean;
}

function key(address: Address): string {
  return address.toLowerCase();
}

function readEntry(store: BalanceStore, address: Address): AddressEntry {
  const existing = store[key(address)];
  if (existing === undefined) {
    return { balanceUusdc: "0", applied: [] };
  }
  return existing;
}

function assertPositiveAmount(amountUusdc: bigint): void {
  if (amountUusdc <= 0n) {
    throw new Error("amountUusdc must be a positive integer");
  }
}

function assertRef(ref: string): void {
  if (ref.trim() === "") {
    throw new Error("ref must be a non-empty string");
  }
}

/**
 * Current balance for an address in uUSDC. Returns 0n when the address has no
 * ledger entry.
 */
export async function getBalance(address: Address): Promise<bigint> {
  const store = await readJson<BalanceStore>(BALANCE_FILE, {});
  return BigInt(readEntry(store, address).balanceUusdc);
}

/**
 * Credit an address by amountUusdc, idempotent by ref. If the ref was already
 * applied to this address, the balance is unchanged and applied is false.
 */
export async function credit(
  address: Address,
  amountUusdc: bigint,
  ref: string,
): Promise<BalanceMutation> {
  assertPositiveAmount(amountUusdc);
  assertRef(ref);

  const store = await readJson<BalanceStore>(BALANCE_FILE, {});
  const entry = readEntry(store, address);

  if (entry.applied.includes(ref)) {
    return { balanceUusdc: BigInt(entry.balanceUusdc), applied: false };
  }

  const next = BigInt(entry.balanceUusdc) + amountUusdc;
  store[key(address)] = {
    balanceUusdc: next.toString(),
    applied: [...entry.applied, ref],
  };
  await writeJson<BalanceStore>(BALANCE_FILE, store);

  return { balanceUusdc: next, applied: true };
}

/**
 * Debit an address by amountUusdc, idempotent by ref. Throws when the balance
 * is insufficient. If the ref was already applied, the balance is unchanged and
 * applied is false.
 */
export async function debit(
  address: Address,
  amountUusdc: bigint,
  ref: string,
): Promise<BalanceMutation> {
  assertPositiveAmount(amountUusdc);
  assertRef(ref);

  const store = await readJson<BalanceStore>(BALANCE_FILE, {});
  const entry = readEntry(store, address);

  if (entry.applied.includes(ref)) {
    return { balanceUusdc: BigInt(entry.balanceUusdc), applied: false };
  }

  const current = BigInt(entry.balanceUusdc);
  if (current < amountUusdc) {
    throw new Error(
      `Insufficient balance: have ${current.toString()} uUSDC, need ${amountUusdc.toString()} uUSDC`,
    );
  }

  const next = current - amountUusdc;
  store[key(address)] = {
    balanceUusdc: next.toString(),
    applied: [...entry.applied, ref],
  };
  await writeJson<BalanceStore>(BALANCE_FILE, store);

  return { balanceUusdc: next, applied: true };
}
