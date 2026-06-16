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

/** Prefix marking a mock (DEMO_MODE no-key / submit-failure) inference id. */
const MOCK_ID_PREFIX = "mock-";

/**
 * Prefix marking a fail-closed inference id. Returned by submitInference when the
 * attester is unreachable / unconfigured AND DEMO_MODE is off, so pollInference
 * resolves it to an UNVERIFIED verdict that is never recorded on-chain.
 */
const FAIL_ID_PREFIX = "fail-";

export function isMockId(id: string): boolean {
  return id.startsWith(MOCK_ID_PREFIX);
}

export function isFailId(id: string): boolean {
  return id.startsWith(FAIL_ID_PREFIX);
}

/**
 * Whether the demo/mock path is enabled. OFF by default (production-safe): the
 * mock verdict (verified=true) is only reachable when DEMO_MODE is explicitly
 * "true" or "1". With DEMO_MODE off, any attester failure fails CLOSED to an
 * unverified result instead of minting a free verified verdict.
 */
function demoMode(): boolean {
  const value = optionalEnv("DEMO_MODE", "").toLowerCase();
  return value === "true" || value === "1";
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
 * submit request throws/returns a non-2xx, the result depends on DEMO_MODE:
 *   - DEMO_MODE on  -> returns a deterministic mock id (verified=true demo path).
 *   - DEMO_MODE off -> FAILS CLOSED: returns a fail id that pollInference resolves
 *     to an UNVERIFIED verdict, so a broken/unconfigured attester can never mint
 *     a verified-true result on-chain. Every fallback is logged loudly.
 */
export async function submitInference(
  goalSpec: string,
  fileBase64: string,
  fileName: string,
  contentType: SupportedContentType,
): Promise<string> {
  const apiKey = optionalEnv("CONFIDENTIAL_AI_API_KEY", "");
  if (apiKey === "") {
    if (demoMode()) {
      console.error(
        "[attester] CONFIDENTIAL_AI_API_KEY not set and DEMO_MODE on — using " +
          "DETERMINISTIC MOCK verdict (verified=true, confidence=high). This is " +
          "a DEMO-ONLY path and must never run in production.",
      );
      return mockId();
    }
    console.error(
      "[attester] CONFIDENTIAL_AI_API_KEY not set and DEMO_MODE off — FAILING " +
        "CLOSED to an unverified result. No verdict will be recorded on-chain. " +
        "Set CONFIDENTIAL_AI_API_KEY for live TEE inference, or DEMO_MODE=true " +
        "to restore the demo mock.",
    );
    return failId();
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
    return submitFallback(`inference submit failed to send: ${String(err)}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return submitFallback(
      `inference submit returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  let payload: { id?: unknown; status?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    return submitFallback(
      `inference submit returned unreadable JSON: ${String(err)}`,
    );
  }

  if (typeof payload.id !== "string" || payload.id.trim() === "") {
    return submitFallback("inference submit response had no id");
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
 * stays crash-free.
 *
 * Fail-closed semantics:
 *   - a fail id (submitInference fail-closed) always resolves to a "failed"
 *     unverified verdict, regardless of DEMO_MODE.
 *   - a mock id, or a missing key on a non-mock id, resolves to the verified
 *     mock verdict ONLY when DEMO_MODE is on; otherwise it FAILS CLOSED. The
 *     verified-true mock is unreachable in production.
 */
export async function pollInference(
  attesterId: string,
  goalSpec: string,
): Promise<PollResult> {
  if (isFailId(attesterId)) {
    return {
      status: "failed",
      verdict: failedVerdict(
        "Verification could not be performed (the attester was unreachable or " +
          "unconfigured). Nothing was recorded. Please try again.",
      ),
    };
  }

  if (isMockId(attesterId)) {
    if (demoMode()) {
      return { status: "completed", verdict: mockVerdict(goalSpec) };
    }
    console.error(
      "[attester] received a mock id with DEMO_MODE off — FAILING CLOSED. A " +
        "mock id should never be produced in production; refusing to record it.",
    );
    return {
      status: "failed",
      verdict: failedVerdict(
        "Verification could not be performed. Nothing was recorded.",
      ),
    };
  }

  const apiKey = optionalEnv("CONFIDENTIAL_AI_API_KEY", "");
  if (apiKey === "") {
    if (demoMode()) {
      // No key but a non-mock id: treat as mock so the demo keeps flowing.
      return { status: "completed", verdict: mockVerdict(goalSpec) };
    }
    console.error(
      "[attester] poll with no CONFIDENTIAL_AI_API_KEY and DEMO_MODE off — " +
        "FAILING CLOSED to an unverified result. Nothing will be recorded.",
    );
    return {
      status: "failed",
      verdict: failedVerdict(
        "Verification is not configured (no attester key). Nothing was recorded.",
      ),
    };
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

/** Deterministic mock inference id (DEMO_MODE no-key / submit failure). */
function mockId(): string {
  return `${MOCK_ID_PREFIX}${Math.random().toString(36).slice(2, 12)}`;
}

/** Fail-closed inference id — pollInference resolves it to an unverified verdict. */
function failId(): string {
  return `${FAIL_ID_PREFIX}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Shared submit-time fallback for an attester error mid-request (after the key
 * check). DEMO_MODE on returns a mock id (demo path); off FAILS CLOSED to a fail
 * id. Logs loudly in both cases so the failure is never silent.
 */
function submitFallback(context: string): string {
  if (demoMode()) {
    console.error(
      `[attester] ${context} — DEMO_MODE on, falling back to MOCK verdict ` +
        `(verified=true). DEMO-ONLY; must never run in production.`,
    );
    return mockId();
  }
  console.error(
    `[attester] ${context} — DEMO_MODE off, FAILING CLOSED to an unverified ` +
      `result. Nothing will be recorded on-chain.`,
  );
  return failId();
}

/**
 * Deterministic mock verdict — DEMO_MODE ONLY. Reachable only when DEMO_MODE is
 * on and the attester is absent/failing; returns verified=true/high so the demo
 * flow still records on-chain. With DEMO_MODE off this is never called (the flow
 * fails closed instead). The reason makes the mock origin explicit and never
 * echoes document contents.
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
