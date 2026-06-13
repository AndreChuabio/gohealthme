import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import {
  isClaimed,
  markClaimed,
  linkUnlinkAddress,
  getUnlinkAddress,
  userOwnsUnlinkAddress,
} from "@/lib/server/claims";

const DATA = path.join(process.cwd(), ".data");

describe("claims store", () => {
  beforeEach(async () => {
    await fs.rm(path.join(DATA, "claims.json"), { force: true });
    await fs.rm(path.join(DATA, "unlink-addresses.json"), { force: true });
  });

  it("reports unclaimed goals as not claimed, then claimed after marking", async () => {
    expect(await isClaimed("goal-1")).toBe(false);
    await markClaimed("goal-1");
    expect(await isClaimed("goal-1")).toBe(true);
  });

  it("markClaimed is idempotent", async () => {
    await markClaimed("goal-1");
    await markClaimed("goal-1");
    expect(await isClaimed("goal-1")).toBe(true);
  });

  it("links and resolves a userId to an unlink address", async () => {
    await linkUnlinkAddress("user-A", "unlink1abc");
    expect(await getUnlinkAddress("user-A")).toBe("unlink1abc");
    expect(await userOwnsUnlinkAddress("user-A", "unlink1abc")).toBe(true);
    expect(await userOwnsUnlinkAddress("user-A", "unlink1xyz")).toBe(false);
  });
});
