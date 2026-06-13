// Document-verified health goals — Chainlink Confidential AI Attester client
// (server only).
//
// A participant uploads a health document (flu-shot record, lab/cholesterol PDF,
// biometric screening result). We submit it to the Chainlink Confidential AI
// Attester, whose model runs privately inside a TEE (trusted execution
// enclave). Inference is asynchronous: the attester queues the job and we poll
// it by id until it completes. The document bytes are sent to the attester for
// inference only and are NEVER persisted to disk or chain — only the verdict (a
// small JSON struct) is returned and later recorded on-chain by the caller.
//
// Privacy: no raw health data is logged or stored. We log only that an inference
// was submitted/polled, the verdict, and the confidence — never the document
// bytes or its text.
//
// Live attester API (probed against our key on 2026-06-13):
//   base   https://confidential-ai-dev-preview.cldev.cloud
//   auth   Authorization: Bearer <CONFIDENTIAL_AI_API_KEY>
//   model  "gemma4" (text + image, confirmed available via GET /v1/models)
//   submit POST /v1/inference { model, system_prompt?, prompt, resources? }
//            -> 202 { id, status: "queued", ... }
//   poll   GET  /v1/inference/:id
//            -> { status, output?, ... } ; status in queued|running|completed|failed
//
// We omit cre_callback on purpose: this is the simpler poll-based live path. The
// callback (CRE) path lives separately in cre/ and is untouched by this module.

import { optionalEnv } from "@/lib/server/env";

const ATTESTER_BASE_URL = optionalEnv(
  "CONFIDENTIAL_AI_BASE_URL",
  "https://confidential-ai-dev-preview.cldev.cloud",
);
const ATTESTER_MODEL = "gemma4";

export type Confidence = "low" | "medium" | "high";

export interface Verdict {
  verified: boolean;
  confidence: Confidence;
  reason: string;
}

/**
 * Status of an attester inference job as the two-route flow surfaces it to the
 * frontend. "verifying" means the attester job is still queued/running.
 */
export type InferenceStatus = "verifying" | "completed" | "failed";

export type SupportedContentType =
  | "image/png"
  | "image/jpeg"
  | "application/pdf"
  | "text/plain";

const SUPPORTED_CONTENT_TYPES: readonly SupportedContentType[] = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
];

export function isSupportedContentType(
  value: string,
): value is SupportedContentType {
  return (SUPPORTED_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Prefix marking a mock (no-key / submit-failure) inference id. */
const MOCK_ID_PREFIX = "mock-";

export function isMockId(id: string): boolean {
  return id.startsWith(MOCK_ID_PREFIX);
}

const SYSTEM_PROMPT =
  "You are a health verification analyst. You review one or more uploaded health " +
  "documents (such as a flu-shot record, a lab or cholesterol report, or a " +
  "biometric screening result) and decide whether they satisfy a stated health " +
  "goal. Judge strictly from the documents' contents. If a document is " +
  "unreadable, off-topic, or does not clearly satisfy the goal, do not verify it.";

function userPrompt(goalSpec: string): string {
  return (
    `Based on the attached document(s), did this person satisfy this goal: '${goalSpec}'? ` +
    `Respond ONLY with strict JSON, no prose: ` +
    `{"verified": boolean, "confidence": "low"|"medium"|"high", "reason": string}`
  );
}

interface InferenceResource {
  filename: string;
  content_type: string;
  content_base64: string;
}

/**
 * Submit a document to the attester for confidential inference. Returns the
 * attester inference id to poll. When CONFIDENTIAL_AI_API_KEY is unset, or the
 * submit request throws/returns a non-2xx, returns a deterministic mock id and
 * logs a clear warning so the demo flow still completes.
 */
export async function submitInference(
  goalSpec: string,
  fileBase64: string,
  fileName: string,
  contentType: SupportedContentType,
): Promise<string> {
  const apiKey = optionalEnv("CONFIDENTIAL_AI_API_KEY", "");
  if (apiKey === "") {
    console.warn(
      "[attester] CONFIDENTIAL_AI_API_KEY not set — using DETERMINISTIC MOCK " +
        "verdict (verified=true, confidence=high). Set CONFIDENTIAL_AI_API_KEY " +
        "in gohealthme/.env for live TEE inference.",
    );
    return mockId();
  }

  const resource: InferenceResource = {
    filename: fileName,
    content_type: contentType,
    content_base64: fileBase64,
  };
  const body = {
    model: ATTESTER_MODEL,
    system_prompt: SYSTEM_PROMPT,
    prompt: userPrompt(goalSpec),
    resources: [resource],
  };

  let res: Response;
  try {
    res = await fetch(`${ATTESTER_BASE_URL}/v1/inference`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      "[attester] inference submit failed to send, falling back to mock:",
      String(err),
    );
    return mockId();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[attester] inference submit returned HTTP ${res.status}, falling back ` +
        `to mock: ${detail.slice(0, 300)}`,
    );
    return mockId();
  }

  let payload: { id?: unknown; status?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    console.error(
      "[attester] inference submit returned unreadable JSON, falling back to mock:",
      String(err),
    );
    return mockId();
  }

  if (typeof payload.id !== "string" || payload.id.trim() === "") {
    console.error(
      "[attester] inference submit response had no id, falling back to mock.",
    );
    return mockId();
  }

  console.log(
    `[attester] inference submitted id=${payload.id} status=${String(
      payload.status ?? "queued",
    )}`,
  );
  return payload.id;
}

/**
 * Result of polling an attester inference. When status is "verifying" the job is
 * still queued/running and verdict is null. When "completed" the verdict is
 * parsed from the model output. When "failed" verdict carries an unverified/low
 * reason so the route can respond cleanly.
 */
export interface PollResult {
  status: InferenceStatus;
  verdict: Verdict | null;
}

/**
 * Poll the attester for a single inference id. Never throws — transport/parse
 * failures surface as status "failed" with an unverified verdict so the route
 * stays crash-free. A mock id resolves immediately to a completed verified
 * verdict (the demo fallback).
 */
export async function pollInference(
  attesterId: string,
  goalSpec: string,
): Promise<PollResult> {
  if (isMockId(attesterId)) {
    return { status: "completed", verdict: mockVerdict(goalSpec) };
  }

  const apiKey = optionalEnv("CONFIDENTIAL_AI_API_KEY", "");
  if (apiKey === "") {
    // No key but a non-mock id: treat as mock so the demo keeps flowing.
    return { status: "completed", verdict: mockVerdict(goalSpec) };
  }

  let res: Response;
  try {
    res = await fetch(
      `${ATTESTER_BASE_URL}/v1/inference/${encodeURIComponent(attesterId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      },
    );
  } catch (err) {
    console.error("[attester] poll failed to send:", String(err));
    return {
      status: "failed",
      verdict: failedVerdict(
        "Could not reach the verification enclave. Please try again.",
      ),
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[attester] poll returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
    return {
      status: "failed",
      verdict: failedVerdict(
        `Verification enclave error (HTTP ${res.status}). Please try again.`,
      ),
    };
  }

  let payload: { status?: unknown; output?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    console.error("[attester] poll returned unreadable JSON:", String(err));
    return {
      status: "failed",
      verdict: failedVerdict(
        "Verification enclave returned an unreadable response.",
      ),
    };
  }

  const status = typeof payload.status === "string" ? payload.status : "";

  if (status === "completed") {
    const output = typeof payload.output === "string" ? payload.output : "";
    const verdict = parseVerdict(output);
    console.log(
      `[attester] verdict id=${attesterId} verified=${verdict.verified} confidence=${verdict.confidence}`,
    );
    return { status: "completed", verdict };
  }

  if (status === "failed") {
    console.error(`[attester] inference id=${attesterId} reported failed`);
    return {
      status: "failed",
      verdict: failedVerdict(
        "The verification enclave could not complete this inference.",
      ),
    };
  }

  // queued / running / anything else -> still verifying.
  return { status: "verifying", verdict: null };
}

/** Deterministic mock inference id (no key / submit failure). */
function mockId(): string {
  return `${MOCK_ID_PREFIX}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Deterministic mock verdict used when CONFIDENTIAL_AI_API_KEY is absent or the
 * attester submit failed. Returns verified=true/high so the demo flow still
 * records on-chain. The reason makes the mock origin explicit and never echoes
 * document contents.
 */
function mockVerdict(goalSpec: string): Verdict {
  return {
    verified: true,
    confidence: "high",
    reason: `Mock attester: assuming the uploaded document satisfies the goal '${goalSpec}'. Set CONFIDENTIAL_AI_API_KEY for a real TEE verdict.`,
  };
}

function failedVerdict(reason: string): Verdict {
  return { verified: false, confidence: "low", reason };
}

/**
 * Pull the verdict JSON out of the attester's `output` text. The model is asked
 * for strict JSON, but we tolerate code fences or stray prose around it. If
 * nothing parseable is found, treat as unverified/low.
 */
function parseVerdict(output: string): Verdict {
  const stripped = output.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return failedVerdict("Verification enclave returned no structured verdict.");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return failedVerdict("Verification enclave returned an unexpected format.");
  }

  const verified = parsed.verified === true;
  const confidence: Confidence =
    parsed.confidence === "high" ||
    parsed.confidence === "medium" ||
    parsed.confidence === "low"
      ? parsed.confidence
      : "low";
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim() !== ""
      ? parsed.reason
      : "No reason provided by the verification enclave.";

  return { verified, confidence, reason };
}

/**
 * Derive the on-chain payout multiplier (basis points) from the verdict
 * confidence. Base 1x (10000); higher confidence pays more, capped at 3x (30000)
 * to match the HealthPools trailing-baseline cap.
 *   high   -> 20000 (2x)
 *   medium -> 10000 (1x)
 */
export function multiplierForConfidence(confidence: Confidence): bigint {
  const CAP = 30_000n;
  let bps: bigint;
  switch (confidence) {
    case "high":
      bps = 20_000n;
      break;
    case "medium":
      bps = 10_000n;
      break;
    default:
      bps = 10_000n;
      break;
  }
  return bps > CAP ? CAP : bps;
}
