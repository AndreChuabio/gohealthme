import { describe, expect, test } from "vitest";
import type { JudgeVote } from "@/lib/server/consensus";
import { aggregateVerdicts } from "@/lib/server/consensus";

// Helper: build a usable judge vote.
function vote(
  verified: boolean,
  confidence: "low" | "medium" | "high",
  judgeId = "j",
): JudgeVote {
  return { judgeId, ok: true, verdict: { verified, confidence, reason: "r" } };
}

// Helper: a judge that failed to produce a verdict (e.g. enclave error).
function failed(judgeId = "x"): JudgeVote {
  return {
    judgeId,
    ok: false,
    verdict: { verified: false, confidence: "low", reason: "enclave error" },
  };
}

describe("aggregateVerdicts", () => {
  test("approves when verified votes meet K and confidence clears the floor", () => {
    const result = aggregateVerdicts(
      [vote(true, "high", "a"), vote(true, "high", "b"), vote(false, "low", "c")],
      { k: 2, confidenceFloor: "medium" },
    );
    expect(result.approved).toBe(true);
    expect(result.verifiedVotes).toBe(2);
    expect(result.totalVotes).toBe(3);
  });

  test("fails closed when verified votes fall short of K", () => {
    const result = aggregateVerdicts(
      [vote(true, "high", "a"), vote(false, "low", "b"), vote(false, "low", "c")],
      { k: 2, confidenceFloor: "medium" },
    );
    expect(result.approved).toBe(false);
    expect(result.verifiedVotes).toBe(1);
  });

  test("rejects when K is met but verified votes' mean confidence is below the floor", () => {
    // Two verified votes but both low confidence -> mean below 'medium'.
    const result = aggregateVerdicts(
      [vote(true, "low", "a"), vote(true, "low", "b")],
      { k: 2, confidenceFloor: "medium" },
    );
    expect(result.approved).toBe(false);
  });

  test("approves at the exact K boundary", () => {
    const result = aggregateVerdicts([vote(true, "medium", "a")], {
      k: 1,
      confidenceFloor: "medium",
    });
    expect(result.approved).toBe(true);
  });

  test("fails closed on an empty panel", () => {
    const result = aggregateVerdicts([], { k: 1, confidenceFloor: "low" });
    expect(result.approved).toBe(false);
    expect(result.verifiedVotes).toBe(0);
    expect(result.totalVotes).toBe(0);
  });

  test("does not count failed judges as verified votes", () => {
    // Only one usable verified vote; the other two judges errored.
    const result = aggregateVerdicts(
      [vote(true, "high", "a"), failed("b"), failed("c")],
      { k: 2, confidenceFloor: "low" },
    );
    expect(result.approved).toBe(false);
    expect(result.verifiedVotes).toBe(1);
  });

  test("reports an aggregate confidence bucket from the verified votes' mean", () => {
    // high + medium -> mean 2.5 -> rounds to high.
    const result = aggregateVerdicts(
      [vote(true, "high", "a"), vote(true, "medium", "b")],
      { k: 2, confidenceFloor: "medium" },
    );
    expect(result.approved).toBe(true);
    expect(result.confidence).toBe("high");
  });

  test("carries the panel votes through for the audit trail", () => {
    const votes = [vote(true, "high", "a"), vote(false, "low", "b")];
    const result = aggregateVerdicts(votes, { k: 1, confidenceFloor: "low" });
    expect(result.votes).toHaveLength(2);
    expect(result.votes.map((v) => v.judgeId)).toEqual(["a", "b"]);
  });
});
