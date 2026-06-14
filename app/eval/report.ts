// Presentation for the reliability run: render the per-config scores as a
// markdown table and call the winner. Pure string-building; the meaningful
// logic lives in score.ts (tested) and consensus.ts (tested).

import type { Score } from "@/eval/score";

export interface ArbiterResult {
  label: string;
  /** How many judges this config draws from the full panel. */
  panelSize: number;
  quorum: string;
  score: Score;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Lowest false-positive rate wins; ties broken by highest accuracy. */
export function pickWinner(results: ArbiterResult[]): ArbiterResult | null {
  if (results.length === 0) return null;
  return [...results].sort(
    (a, b) =>
      a.score.falsePositiveRate - b.score.falsePositiveRate ||
      b.score.accuracy - a.score.accuracy,
  )[0];
}

export function formatReport(
  results: ArbiterResult[],
  totalCases: number,
): string {
  const winner = pickWinner(results);
  const lines: string[] = [];
  lines.push(`# Arbiter reliability report`);
  lines.push("");
  lines.push(
    `Ran **${totalCases}** synthetic lab cases through the confidential ` +
      `attester and scored ${results.length} arbiter configs. ` +
      `Headline metric = **false-positive rate** (wrongful USDC payouts).`,
  );
  lines.push("");
  lines.push(
    `| Config | Judges | Quorum | Accuracy | False-positive rate | FP | FN |`,
  );
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const star = winner && r.label === winner.label ? " ⭐" : "";
    lines.push(
      `| ${r.label}${star} | ${r.panelSize} | ${r.quorum} | ` +
        `${pct(r.score.accuracy)} | ${pct(r.score.falsePositiveRate)} | ` +
        `${r.score.fp} | ${r.score.fn} |`,
    );
  }
  lines.push("");
  if (winner) {
    lines.push(
      `**Winner: ${winner.label}** — ${pct(winner.score.accuracy)} accuracy, ` +
        `${pct(winner.score.falsePositiveRate)} false-positive rate ` +
        `(${winner.score.fp} wrongful approvals out of ` +
        `${winner.score.fp + winner.score.tn} should-fail cases).`,
    );
  }
  return lines.join("\n");
}
