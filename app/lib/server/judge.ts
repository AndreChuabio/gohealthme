// Document-verified health goals — AI judge (server only).
//
// A participant uploads a health document (flu-shot record, lab/cholesterol PDF,
// biometric screening result). We send it to Anthropic Claude and ask whether it
// satisfies the pool goal. The document is sent to the judge for inference and is
// NEVER persisted to disk or chain — only the verdict (a small JSON struct) is
// returned and later recorded on-chain by the caller.
//
// Privacy: no raw health data is logged or stored. We log only that a judgement
// ran, the verdict, and the confidence — never the document bytes or its text.
//
// SDK note: @anthropic-ai/sdk is NOT installed in this project, so this module
// talks to the Anthropic Messages API over a direct fetch (POST
// https://api.anthropic.com/v1/messages, x-api-key + anthropic-version headers).
// The content-block shapes below were verified against docs.anthropic.com
// (build-with-claude/pdf-support and build-with-claude/vision) on 2026-06-13:
//   image:    { type: "image",    source: { type: "base64", media_type, data } }
//   document: { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
// Neither inline shape requires a beta header.

import { optionalEnv } from "@/lib/server/env";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Current fast vision-capable model (200K context). Handles image + PDF input.
const MODEL = "claude-haiku-4-5-20251001";

export type Confidence = "low" | "medium" | "high";

export interface Verdict {
  verified: boolean;
  confidence: Confidence;
  reason: string;
  /** true when the deterministic mock judge produced this verdict (no API key). */
  mock: boolean;
}

export type SupportedContentType =
  | "image/png"
  | "image/jpeg"
  | "application/pdf";

const SUPPORTED_CONTENT_TYPES: readonly SupportedContentType[] = [
  "image/png",
  "image/jpeg",
  "application/pdf",
];

export function isSupportedContentType(
  value: string,
): value is SupportedContentType {
  return (SUPPORTED_CONTENT_TYPES as readonly string[]).includes(value);
}

const SYSTEM_PROMPT =
  "You are a health verification analyst. You review a single uploaded health " +
  "document (such as a flu-shot record, a lab or cholesterol report, or a " +
  "biometric screening result) and decide whether it satisfies a stated health " +
  "goal. Judge strictly from the document's contents. If the document is " +
  "unreadable, off-topic, or does not clearly satisfy the goal, do not verify it.";

interface ContentBlock {
  type: "image" | "document" | "text";
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
  text?: string;
}

function buildDocumentBlock(
  contentType: SupportedContentType,
  fileBase64: string,
): ContentBlock {
  if (contentType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: fileBase64 },
    };
  }
  // image/png or image/jpeg
  return {
    type: "image",
    source: { type: "base64", media_type: contentType, data: fileBase64 },
  };
}

function userPrompt(goalSpec: string): string {
  return (
    `Based on the attached document, did this person satisfy this goal: '${goalSpec}'? ` +
    `Respond ONLY with JSON: {verified: boolean, confidence: 'low'|'medium'|'high', reason: string}`
  );
}

/**
 * Deterministic mock judge used when ANTHROPIC_API_KEY is absent. Returns a
 * verified=true/high verdict so the demo flow still records on-chain. The reason
 * makes the mock origin explicit and never echoes document contents.
 */
function mockVerdict(goalSpec: string): Verdict {
  console.warn(
    "[judge] ANTHROPIC_API_KEY not set — using DETERMINISTIC MOCK judge " +
      "(verified=true, confidence=high). Set ANTHROPIC_API_KEY in app/.env.local " +
      "for the live Claude judge.",
  );
  return {
    verified: true,
    confidence: "high",
    reason: `Mock judge: assuming the uploaded document satisfies the goal '${goalSpec}'. Set ANTHROPIC_API_KEY for a real verdict.`,
    mock: true,
  };
}

/**
 * Pull the first JSON object out of Claude's text response. The model is asked
 * for JSON-only, but we tolerate stray prose or code fences around it.
 */
function parseVerdictJson(text: string): {
  verified: boolean;
  confidence: Confidence;
  reason: string;
} {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Judge response did not contain a JSON object");
  }
  const slice = text.slice(start, end + 1);
  const parsed = JSON.parse(slice) as Record<string, unknown>;

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
      : "No reason provided by judge.";

  return { verified, confidence, reason };
}

/**
 * Judge whether the uploaded document satisfies the goal. Uses Claude when
 * ANTHROPIC_API_KEY is set; otherwise falls back to a deterministic mock that
 * verifies true/high for the demo (and logs that it did so). Never throws on a
 * model/transport error — surfaces a low-confidence unverified verdict instead,
 * so the route can respond cleanly without crashing.
 */
export async function judgeDocument(
  goalSpec: string,
  fileBase64: string,
  contentType: SupportedContentType,
): Promise<Verdict> {
  const apiKey = optionalEnv("ANTHROPIC_API_KEY", "");
  if (apiKey === "") {
    return mockVerdict(goalSpec);
  }

  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          buildDocumentBlock(contentType, fileBase64),
          { type: "text", text: userPrompt(goalSpec) },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[judge] Anthropic request failed to send:", String(err));
    return {
      verified: false,
      confidence: "low",
      reason: "Could not reach the verification service. Please try again.",
      mock: false,
    };
  }

  if (!res.ok) {
    // Read the error body for diagnostics, but never log document contents.
    const detail = await res.text().catch(() => "");
    console.error(
      `[judge] Anthropic returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
    return {
      verified: false,
      confidence: "low",
      reason: `Verification service error (HTTP ${res.status}). Please try again.`,
      mock: false,
    };
  }

  let payload: { content?: Array<{ type: string; text?: string }> };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    console.error("[judge] Failed to parse Anthropic response JSON:", String(err));
    return {
      verified: false,
      confidence: "low",
      reason: "Verification service returned an unreadable response.",
      mock: false,
    };
  }

  const text = (payload.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();

  try {
    const { verified, confidence, reason } = parseVerdictJson(text);
    console.log(
      `[judge] verdict via Claude: verified=${verified} confidence=${confidence}`,
    );
    return { verified, confidence, reason, mock: false };
  } catch (err) {
    console.error("[judge] Could not parse verdict from response:", String(err));
    return {
      verified: false,
      confidence: "low",
      reason: "Verification service returned an unexpected format.",
      mock: false,
    };
  }
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
