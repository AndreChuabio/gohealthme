// Regression tests for the two-write recording flow.
//
// Recording a verified goal takes TWO on-chain writes, and with the settlement
// gate enabled BOTH are required before the participant can be paid:
//   1. HealthPools.recordResult   — the oracle result
//   2. HealthVerdict.recordVerdict — the entry settle() gates on via canSettle()
//
// The defects these pin:
//   a. A failed step 2 used to be swallowed and reported as recorded:true, so a
//      verified user was told they succeeded while being unpayable at settlement.
//   b. Step 1's ALREADY_RECORDED revert used to return early, BEFORE step 2. That
//      made (a) permanent: once the result was on chain, every later poll
//      short-circuited and the registry verdict could never be written.

import { describe, it, expect, vi, beforeEach } from "vitest";

const recordResult = vi.fn();
const recordVerdict = vi.fn();
const pollInference = vi.fn();

vi.mock("@/lib/server/oracle", () => ({
  recordResult: (...args: unknown[]) => recordResult(...args),
}));
vi.mock("@/lib/server/verdict", () => ({
  recordVerdict: (...args: unknown[]) => recordVerdict(...args),
}));
vi.mock("@/lib/server/judge", () => ({
  pollInference: (...args: unknown[]) => pollInference(...args),
  multiplierForConfidence: () => 10_000n,
}));

const { POST } = await import("@/app/api/evidence/result/route");

const USER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const TX = "0xabc123";

function post() {
  return POST(
    new Request("http://localhost/api/evidence/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attesterId: "att-1",
        poolId: "1",
        address: USER,
        goalSpec: "10,000 steps daily for 5 days",
      }),
    }),
  );
}

function passingInference() {
  pollInference.mockResolvedValue({
    status: "completed",
    verdict: { verified: true, confidence: "high", reason: "8450 steps/day" },
  });
}

describe("POST /api/evidence/result — two-write recording", () => {
  beforeEach(() => {
    recordResult.mockReset();
    recordVerdict.mockReset();
    pollInference.mockReset();
  });

  it("reports success only when BOTH writes land", async () => {
    passingInference();
    recordResult.mockResolvedValue(TX);
    recordVerdict.mockResolvedValue({ status: "recorded", txHash: "0xdef", goalId: "0x1" });

    const body = await (await post()).json();

    expect(body).toMatchObject({ status: "completed", recorded: true, txHash: TX });
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordVerdict).toHaveBeenCalledTimes(1);
  });

  // Defect (a): a swallowed registry failure reported as success.
  it("does NOT report success when the registry write fails", async () => {
    passingInference();
    recordResult.mockResolvedValue(TX);
    recordVerdict.mockRejectedValue(new Error("recordVerdict failed after 3 attempts"));

    const body = await (await post()).json();

    expect(body.recorded).toBe(false);
    expect(body.verified).toBe(true); // the verdict itself still stands
    expect(body.error).toMatch(/cannot pay out yet/i);
    expect(body.error).toMatch(/re-submit to retry/i);
  });

  // Defect (b): the ALREADY_RECORDED short-circuit skipped the registry write, so
  // a participant stranded by a failed step 2 could never recover. Every poll
  // must still attempt step 2.
  it("still writes the registry verdict when the result is ALREADY_RECORDED", async () => {
    passingInference();
    recordResult.mockRejectedValue(new Error("execution reverted: ALREADY_RECORDED"));
    recordVerdict.mockResolvedValue({ status: "recorded", txHash: "0xdef", goalId: "0x1" });

    const body = await (await post()).json();

    expect(recordVerdict).toHaveBeenCalledTimes(1); // the recovery path
    expect(body.recorded).toBe(true);
  });

  it("recovers a stranded participant across polls: fail, then succeed", async () => {
    passingInference();
    // Poll 1: result lands, registry write fails -> stranded, reported as failure.
    recordResult.mockResolvedValueOnce(TX);
    recordVerdict.mockRejectedValueOnce(new Error("RPC timeout"));
    const first = await (await post()).json();
    expect(first.recorded).toBe(false);

    // Poll 2: result already on chain, registry write now succeeds -> recovered.
    recordResult.mockRejectedValueOnce(new Error("execution reverted: ALREADY_RECORDED"));
    recordVerdict.mockResolvedValueOnce({ status: "recorded", txHash: "0xdef", goalId: "0x1" });
    const second = await (await post()).json();
    expect(second.recorded).toBe(true);
    expect(recordVerdict).toHaveBeenCalledTimes(2);
  });

  it("treats an already-recorded registry verdict as success, not failure", async () => {
    passingInference();
    recordResult.mockResolvedValue(TX);
    recordVerdict.mockResolvedValue({ status: "already-recorded", goalId: "0x1" });

    const body = await (await post()).json();
    expect(body.recorded).toBe(true);
  });

  it("skips both writes and never claims success for a non-participant", async () => {
    passingInference();
    recordResult.mockRejectedValue(new Error("execution reverted: NOT_PARTICIPANT"));

    const body = await (await post()).json();

    expect(body.recorded).toBe(false);
    expect(body.error).toMatch(/has not joined pool 1/);
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  it("writes nothing on chain for an unverified or low-confidence result", async () => {
    pollInference.mockResolvedValue({
      status: "completed",
      verdict: { verified: true, confidence: "low", reason: "unclear document" },
    });

    const body = await (await post()).json();

    expect(body.recorded).toBe(false);
    expect(recordResult).not.toHaveBeenCalled();
    expect(recordVerdict).not.toHaveBeenCalled();
  });
});
