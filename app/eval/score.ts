// Scoring for the reliability harness: reduce per-case outcomes to a confusion
// matrix and the metrics that matter. The headline is the FALSE-POSITIVE RATE —
// of the cases that should have been rejected, how many did the arbiter wrongly
// approve. For an oracle that releases USDC, that is the number to drive to zero.

export interface CaseOutcome {
  /** Ground truth: should the arbiter have approved this evidence. */
  shouldPass: boolean;
  /** What the arbiter's consensus actually decided. */
  approved: boolean;
}

export interface Score {
  /** Correctly approved (shouldPass && approved). */
  tp: number;
  /** Correctly rejected (!shouldPass && !approved). */
  tn: number;
  /** Wrongly approved (!shouldPass && approved) — wrongful payouts. */
  fp: number;
  /** Wrongly rejected (shouldPass && !approved). */
  fn: number;
  total: number;
  accuracy: number;
  /** fp / (fp + tn). 0 when there are no should-fail cases. */
  falsePositiveRate: number;
  /** fn / (fn + tp). 0 when there are no should-pass cases. */
  falseNegativeRate: number;
}

export function score(outcomes: CaseOutcome[]): Score {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const o of outcomes) {
    if (o.shouldPass && o.approved) tp++;
    else if (!o.shouldPass && !o.approved) tn++;
    else if (!o.shouldPass && o.approved) fp++;
    else fn++;
  }

  const total = outcomes.length;
  const negatives = fp + tn;
  const positives = fn + tp;

  return {
    tp,
    tn,
    fp,
    fn,
    total,
    accuracy: total === 0 ? 0 : (tp + tn) / total,
    falsePositiveRate: negatives === 0 ? 0 : fp / negatives,
    falseNegativeRate: positives === 0 ? 0 : fn / positives,
  };
}
