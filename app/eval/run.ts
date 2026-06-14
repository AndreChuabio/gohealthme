// Orchestrator for the arbiter reliability harness.
//
//   corpus -> full judge panel (once per case) -> score many quorum configs
//   -> markdown + JSON report -> winning arbiter config.
//
// We run the FULL panel (both models x all prompt variants) once per case, then
// evaluate every candidate arbiter config by subsetting those votes. Sweeping
// thresholds therefore costs zero extra enclave calls.
//
// Run:  npx tsx eval/run.ts        (from the app/ directory)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Buffer } from "node:buffer";
import { CORPUS } from "@/eval/corpus";
import { aggregateVerdicts, type JudgeVote } from "@/lib/server/consensus";
import { runPanel, type PanelConfig } from "@/lib/server/panel";
import { score, type CaseOutcome } from "@/eval/score";
import { formatReport, pickWinner, type ArbiterResult } from "@/eval/report";

// --- minimal .env loader (no dotenv dependency) ---------------------------
function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// --- the full panel run once per case -------------------------------------
// 2 judges for now: the two enclave models on the strict prompt (the model A/B).
const FULL_PANEL: PanelConfig = {
  models: ["gemma4", "qwen3.6"],
  promptIds: ["strict"],
  samplesPerCombo: 1,
  temperature: 0,
};

// --- candidate arbiter configs (subset + quorum) --------------------------
interface ArbiterConfig {
  label: string;
  select: (judgeId: string) => boolean;
  k: number;
  confidenceFloor: "low" | "medium" | "high";
}

const ARBITERS: ArbiterConfig[] = [
  {
    label: "gemma4 · strict (single-shot, baseline)",
    select: (id) => id === "gemma4/strict/0",
    k: 1,
    confidenceFloor: "medium",
  },
  {
    label: "qwen3.6 · strict (single-shot)",
    select: (id) => id === "qwen3.6/strict/0",
    k: 1,
    confidenceFloor: "medium",
  },
  {
    label: "2-model · strict · unanimous (both must agree)",
    select: () => true,
    k: 2,
    confidenceFloor: "medium",
  },
];

async function main() {
  loadEnv("../.env");
  loadEnv(".env.local");
  loadEnv("../.env.local");

  const haveKey = (process.env.CONFIDENTIAL_AI_API_KEY ?? "").trim() !== "";
  console.log(
    haveKey
      ? "[harness] live enclave mode (CONFIDENTIAL_AI_API_KEY set)"
      : "[harness] MOCK mode — no CONFIDENTIAL_AI_API_KEY; verdicts are stubbed",
  );

  // 1) Run the full panel once per case, recording every vote. Cases run with
  // bounded concurrency to overlap the enclave's multi-minute queue waits; the
  // submit-side 429 backoff throttles us to the real per-key limit.
  const CASE_CONCURRENCY = 3;
  const perCaseVotes: { id: string; shouldPass: boolean; votes: JudgeVote[] }[] =
    new Array(CORPUS.length);
  let cursor = 0;
  async function worker() {
    while (cursor < CORPUS.length) {
      const index = cursor++;
      const c = CORPUS[index];
      console.log(`[harness] judging case ${c.id} …`);
      const votes = await runPanel(
        {
          goalSpec: c.goalSpec,
          fileBase64: Buffer.from(c.content, "utf8").toString("base64"),
          fileName: c.fileName,
          contentType: c.contentType,
        },
        FULL_PANEL,
      );
      perCaseVotes[index] = { id: c.id, shouldPass: c.shouldPass, votes };
      console.log(`[harness] done case ${c.id}`);
    }
  }
  await Promise.all(
    Array.from({ length: CASE_CONCURRENCY }, () => worker()),
  );

  // 2) Score each candidate arbiter config by subsetting the recorded votes.
  const results: ArbiterResult[] = ARBITERS.map((arb) => {
    let panelSize = 0;
    const outcomes: CaseOutcome[] = perCaseVotes.map((c) => {
      const subset = c.votes.filter((v) => arb.select(v.judgeId));
      panelSize = subset.length;
      const consensus = aggregateVerdicts(subset, {
        k: arb.k,
        confidenceFloor: arb.confidenceFloor,
      });
      return { shouldPass: c.shouldPass, approved: consensus.approved };
    });
    return {
      label: arb.label,
      panelSize,
      quorum: `${arb.k}-of-${panelSize} @ ${arb.confidenceFloor}`,
      score: score(outcomes),
    };
  });

  // 3) Report.
  const markdown = formatReport(results, CORPUS.length);
  console.log("\n" + markdown + "\n");

  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/report.md", markdown + "\n");
  writeFileSync(
    "eval/reports/raw.json",
    JSON.stringify({ perCaseVotes, results }, null, 2),
  );
  const winner = pickWinner(results);
  writeFileSync(
    "eval/reports/winner.json",
    JSON.stringify(winner, null, 2),
  );
  console.log("[harness] wrote eval/reports/{report.md,raw.json,winner.json}");
}

main().catch((err) => {
  console.error("[harness] failed:", err);
  process.exitCode = 1;
});
