import { describe, expect, test } from "vitest";
import { PROMPT_VARIANTS, expandPanel } from "@/lib/server/panel";

describe("expandPanel", () => {
  test("produces one slot per model x prompt x sample", () => {
    const slots = expandPanel({
      models: ["gemma4", "qwen3.6"],
      promptIds: ["strict"],
      samplesPerCombo: 2,
      temperature: 0.3,
    });
    expect(slots).toHaveLength(4);
  });

  test("gives each slot a unique, descriptive judgeId", () => {
    const slots = expandPanel({
      models: ["gemma4"],
      promptIds: ["strict", "lenient"],
      samplesPerCombo: 1,
    });
    const ids = slots.map((s) => s.judgeId);
    expect(ids).toEqual(["gemma4/strict/0", "gemma4/lenient/0"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("defaults to one sample at temperature 0 when unspecified", () => {
    const slots = expandPanel({ models: ["gemma4"], promptIds: ["strict"] });
    expect(slots).toHaveLength(1);
    expect(slots[0].temperature).toBe(0);
  });

  test("carries model, promptId and sampleIndex onto each slot", () => {
    const slots = expandPanel({
      models: ["qwen3.6"],
      promptIds: ["fewshot"],
      samplesPerCombo: 1,
    });
    expect(slots[0].model).toBe("qwen3.6");
    expect(slots[0].promptId).toBe("fewshot");
    expect(slots[0].sampleIndex).toBe(0);
  });

  test("rejects an unknown prompt id", () => {
    expect(() =>
      expandPanel({ models: ["gemma4"], promptIds: ["nope"] }),
    ).toThrow();
  });
});

describe("PROMPT_VARIANTS", () => {
  test("defines strict, lenient and fewshot variants", () => {
    expect(Object.keys(PROMPT_VARIANTS).sort()).toEqual([
      "fewshot",
      "lenient",
      "strict",
    ]);
  });

  test("each variant builds a user prompt that embeds the goal and demands strict JSON", () => {
    for (const variant of Object.values(PROMPT_VARIANTS)) {
      const prompt = variant.buildUserPrompt("walk 10000 steps");
      expect(prompt).toContain("walk 10000 steps");
      expect(prompt.toLowerCase()).toContain("json");
    }
  });
});
