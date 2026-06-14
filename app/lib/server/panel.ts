// Judge panel: turn one piece of evidence into many independent verdicts.
//
// The enclave exposes only two models (gemma4, qwen3.6), so panel diversity
// comes from {model} x {prompt variant} x {repeated sample}. expandPanel() is
// the pure expansion of a config into judge slots (unit-tested); runPanel()
// fans those slots out across the real attester and collects the votes, which
// aggregateVerdicts() (consensus.ts) then reduces to an approve/reject.

import {
  pollInference,
  submitInferenceRaw,
  type Confidence,
  type SupportedContentType,
  type Verdict,
} from "@/lib/server/judge";
import type { JudgeVote } from "@/lib/server/consensus";

/** A prompt framing for the judges. Diversity here surfaces disagreement. */
export interface PromptVariant {
  id: string;
  systemPrompt: string;
  buildUserPrompt: (goalSpec: string) => string;
}

const JSON_INSTRUCTION =
  `Respond ONLY with strict JSON, no prose: ` +
  `{"verified": boolean, "confidence": "low"|"medium"|"high", "reason": string}`;

export const PROMPT_VARIANTS: Record<string, PromptVariant> = {
  strict: {
    id: "strict",
    systemPrompt:
      "You are a strict health verification analyst. Judge ONLY from the " +
      "document's contents. If a document is unreadable, off-topic, expired, " +
      "for a different person, or does not clearly satisfy the goal, do NOT " +
      "verify it. When in doubt, do not verify.",
    buildUserPrompt: (goalSpec) =>
      `Based on the attached document(s), did this person satisfy this goal: ` +
      `'${goalSpec}'? Be strict. ${JSON_INSTRUCTION}`,
  },
  lenient: {
    id: "lenient",
    systemPrompt:
      "You are a health verification analyst. Give the participant reasonable " +
      "benefit of the doubt, but never verify a document that is clearly " +
      "off-topic, for a different person, or contradicts the goal.",
    buildUserPrompt: (goalSpec) =>
      `Based on the attached document(s), does this reasonably satisfy the ` +
      `goal: '${goalSpec}'? ${JSON_INSTRUCTION}`,
  },
  fewshot: {
    id: "fewshot",
    systemPrompt:
      "You are a health verification analyst. Judge strictly from the " +
      "document. Examples: a cholesterol panel dated this year showing LDL " +
      "below the goal threshold for the named participant => verified. The " +
      "same panel but for a different patient name, or dated three years ago, " +
      "or with LDL above the threshold => not verified.",
    buildUserPrompt: (goalSpec) =>
      `Following those examples, did this person satisfy the goal: ` +
      `'${goalSpec}'? ${JSON_INSTRUCTION}`,
  },
};

export interface JudgeSlot {
  judgeId: string;
  model: string;
  promptId: string;
  sampleIndex: number;
  temperature: number;
}

export interface PanelConfig {
  models: string[];
  promptIds: string[];
  /** Samples drawn per (model, prompt) combo. Default 1. */
  samplesPerCombo?: number;
  /** Sampling temperature. Default 0 (deterministic single-shot). */
  temperature?: number;
}

/** Pure: expand a config into the concrete judge slots it describes. */
export function expandPanel(config: PanelConfig): JudgeSlot[] {
  const samples = config.samplesPerCombo ?? 1;
  const temperature = config.temperature ?? 0;
  const slots: JudgeSlot[] = [];
  for (const model of config.models) {
    for (const promptId of config.promptIds) {
      if (!PROMPT_VARIANTS[promptId]) {
        throw new Error(`Unknown prompt variant: '${promptId}'`);
      }
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
        slots.push({
          judgeId: `${model}/${promptId}/${sampleIndex}`,
          model,
          promptId,
          sampleIndex,
          temperature,
        });
      }
    }
  }
  return slots;
}

export interface PanelEvidence {
  goalSpec: string;
  fileBase64: string;
  fileName: string;
  contentType: SupportedContentType;
}

// The shared dev-preview enclave can leave a job queued for several minutes
// before it runs, so poll patiently.
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 720_000; // 12 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Submit one slot and poll it to a terminal verdict, never throwing. */
async function runSlot(
  slot: JudgeSlot,
  evidence: PanelEvidence,
): Promise<JudgeVote> {
  const variant = PROMPT_VARIANTS[slot.promptId];
  let id: string;
  try {
    id = await submitInferenceRaw(
      {
        model: slot.model,
        systemPrompt: variant.systemPrompt,
        prompt: variant.buildUserPrompt(evidence.goalSpec),
        resource: {
          filename: evidence.fileName,
          content_type: evidence.contentType,
          content_base64: evidence.fileBase64,
        },
        temperature: slot.temperature,
      },
      // Harness honesty: a rate-limit or error must fail closed as an error
      // vote, never silently become a mock "verified=true". Many retries so
      // heavy per-key contention backs off rather than failing the judge.
      { allowMock: false, maxRetries: 8 },
    );
  } catch (err) {
    return errorVote(slot.judgeId, `submit failed: ${String(err)}`);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status, verdict } = await pollInference(id, evidence.goalSpec);
    if (status === "completed" && verdict) {
      return { judgeId: slot.judgeId, ok: true, verdict };
    }
    if (status === "failed") {
      return errorVote(
        slot.judgeId,
        verdict?.reason ?? "enclave reported failed",
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return errorVote(slot.judgeId, "timed out waiting for the enclave");
}

function errorVote(judgeId: string, reason: string): JudgeVote {
  const verdict: Verdict = {
    verified: false,
    confidence: "low" as Confidence,
    reason,
  };
  return { judgeId, ok: false, verdict };
}

/** Run the whole panel over one piece of evidence, concurrently. */
export async function runPanel(
  evidence: PanelEvidence,
  config: PanelConfig,
): Promise<JudgeVote[]> {
  const slots = expandPanel(config);
  return Promise.all(slots.map((slot) => runSlot(slot, evidence)));
}
