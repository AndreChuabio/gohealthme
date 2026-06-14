import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { submitInferenceRaw } from "@/lib/server/judge";

// submitInferenceRaw has a product-friendly mock fallback (a missing key or a
// transport error resolves to a deterministic mock id so the demo keeps
// flowing). The eval harness MUST be able to turn that off: in a measurement
// run a failure has to surface as an error, never as a silent mock that the
// consensus would read as verified=true.

describe("submitInferenceRaw mock fallback", () => {
  const KEY = "CONFIDENTIAL_AI_API_KEY";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  const params = {
    model: "gemma4",
    systemPrompt: "s",
    prompt: "p",
  };

  test("returns a mock id when the key is missing and mock is allowed (default)", async () => {
    delete process.env[KEY];
    const id = await submitInferenceRaw(params);
    expect(id.startsWith("mock-")).toBe(true);
  });

  test("throws when the key is missing and mock is disallowed", async () => {
    delete process.env[KEY];
    await expect(
      submitInferenceRaw(params, { allowMock: false }),
    ).rejects.toThrow();
  });
});
