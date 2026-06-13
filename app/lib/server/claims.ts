// Hackathon-grade claim + identity store, built on the existing JSON store.
import { readJson, writeJson } from "@/lib/server/store";

const CLAIMS_FILE = "claims.json";
const ADDR_FILE = "unlink-addresses.json";

type ClaimMap = Record<string, true>;
type AddrMap = Record<string, string>; // userId -> unlink1...

export async function isClaimed(goalId: string): Promise<boolean> {
  const map = await readJson<ClaimMap>(CLAIMS_FILE, {});
  return map[goalId] === true;
}

export async function markClaimed(goalId: string): Promise<void> {
  const map = await readJson<ClaimMap>(CLAIMS_FILE, {});
  map[goalId] = true;
  await writeJson(CLAIMS_FILE, map);
}

export async function linkUnlinkAddress(
  userId: string,
  unlinkAddress: string,
): Promise<void> {
  const map = await readJson<AddrMap>(ADDR_FILE, {});
  map[userId] = unlinkAddress;
  await writeJson(ADDR_FILE, map);
}

export async function getUnlinkAddress(
  userId: string,
): Promise<string | null> {
  const map = await readJson<AddrMap>(ADDR_FILE, {});
  return map[userId] ?? null;
}

export async function userOwnsUnlinkAddress(
  userId: string,
  unlinkAddress: string,
): Promise<boolean> {
  return (await getUnlinkAddress(userId)) === unlinkAddress;
}
