import { describe, expect, test } from "vitest";
import { score } from "@/eval/score";

describe("score", () => {
  test("perfect results: full accuracy, zero false positives", () => {
    const s = score([
      { shouldPass: true, approved: true },
      { shouldPass: false, approved: false },
      { shouldPass: false, approved: false },
    ]);
    expect(s.tp).toBe(1);
    expect(s.tn).toBe(2);
    expect(s.fp).toBe(0);
    expect(s.fn).toBe(0);
    expect(s.accuracy).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
  });

  test("a wrongful approval counts as a false positive and drives FPR", () => {
    // 2 should-fail cases; 1 wrongly approved -> FPR = 1/2.
    const s = score([
      { shouldPass: false, approved: true },
      { shouldPass: false, approved: false },
    ]);
    expect(s.fp).toBe(1);
    expect(s.tn).toBe(1);
    expect(s.falsePositiveRate).toBe(0.5);
  });

  test("a missed pass counts as a false negative and drives FNR", () => {
    const s = score([
      { shouldPass: true, approved: false },
      { shouldPass: true, approved: true },
    ]);
    expect(s.fn).toBe(1);
    expect(s.tp).toBe(1);
    expect(s.falseNegativeRate).toBe(0.5);
  });

  test("empty input yields zeros, not NaN", () => {
    const s = score([]);
    expect(s.total).toBe(0);
    expect(s.accuracy).toBe(0);
    expect(s.falsePositiveRate).toBe(0);
    expect(s.falseNegativeRate).toBe(0);
  });

  test("false-positive rate is 0 when there are no should-fail cases", () => {
    const s = score([{ shouldPass: true, approved: true }]);
    expect(s.falsePositiveRate).toBe(0);
  });
});
