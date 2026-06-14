// Multi-judge consensus for the confidential arbiter.
//
// The attester can only judge with the two enclave models (gemma4, qwen3.6), so
// we build a "panel" by varying {model} x {prompt} x {repeated samples} and
// require a quorum to agree before recording a verdict. Because a verdict gates
// a USDC payout, the rule FAILS CLOSED: disagreement, low confidence, or judge
// errors all resolve to NOT approved (no payout), never to a wrongful approval.
//
// This module is pure and shared by both the eval harness (which sweeps K/N to
// find the threshold that drives false positives to zero) and production (which
// adopts the winning config). No I/O, no logging of document contents.

import type { Confidence, Verdict } from "@/lib/server/judge";

/** One judge's contribution to the panel. */
export interface JudgeVote {
  /** Identifies the panel slot, e.g. "qwen3.6/strict/sample-0". */
  judgeId: string;
  /** False when the judge could not produce a usable verdict (enclave error). */
  ok: boolean;
  verdict: Verdict;
}

/** Tunable quorum rule. */
export interface QuorumConfig {
  /** Minimum number of usable "verified" votes required to approve. */
  k: number;
  /** Minimum mean confidence (over the verified votes) required to approve. */
  confidenceFloor: Confidence;
}

export interface ConsensusResult {
  approved: boolean;
  verifiedVotes: number;
  totalVotes: number;
  /** Numeric mean confidence over the verified votes (low=1..high=3), 0 if none. */
  meanConfidence: number;
  /** Aggregate confidence bucket derived from meanConfidence. */
  confidence: Confidence;
  reason: string;
  /** Every vote, carried through for the audit trail. */
  votes: JudgeVote[];
}

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function bucketFromScore(score: number): Confidence {
  if (score >= 2.5) return "high";
  if (score >= 1.5) return "medium";
  return "low";
}

export function aggregateVerdicts(
  votes: JudgeVote[],
  config: QuorumConfig,
): ConsensusResult {
  const verified = votes.filter((v) => v.ok && v.verdict.verified);
  const verifiedVotes = verified.length;

  const meanConfidence =
    verifiedVotes === 0
      ? 0
      : verified.reduce(
          (sum, v) => sum + CONFIDENCE_SCORE[v.verdict.confidence],
          0,
        ) / verifiedVotes;

  const meetsQuorum = verifiedVotes >= config.k;
  const clearsFloor =
    meanConfidence >= CONFIDENCE_SCORE[config.confidenceFloor];
  const approved = meetsQuorum && clearsFloor;

  const reason = approved
    ? `Approved: ${verifiedVotes}/${votes.length} judges verified (>= K=${config.k}) at mean confidence ${meanConfidence.toFixed(2)}.`
    : `Not approved (fail-closed): ${verifiedVotes}/${votes.length} verified, K=${config.k}, mean confidence ${meanConfidence.toFixed(2)} vs floor '${config.confidenceFloor}'.`;

  return {
    approved,
    verifiedVotes,
    totalVotes: votes.length,
    meanConfidence,
    confidence: bucketFromScore(meanConfidence),
    reason,
    votes,
  };
}
