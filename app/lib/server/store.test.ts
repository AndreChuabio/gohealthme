import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for @upstash/redis so we can exercise the Redis branch of
// store.ts without a live instance. Mirrors the get/set semantics store.ts
// relies on: set stores the value as-is, get returns it (or null if absent).
const backing = new Map<string, unknown>();
class FakeRedis {
  constructor(_opts: { url: string; token: string }) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<T | null> {
    return (backing.has(key) ? (backing.get(key) as T) : null) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async set(key: string, value: unknown): Promise<void> {
    backing.set(key, value);
  }
}
vi.mock("@upstash/redis", () => ({ Redis: FakeRedis }));

// store.ts picks its backend at module load from env, so set Redis env BEFORE
// importing it and import fresh inside the test.
async function loadStoreWithRedis() {
  vi.stubEnv("KV_REST_API_URL", "https://fake.upstash.io");
  vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
  vi.resetModules();
  return import("@/lib/server/store");
}

describe("store (Redis branch)", () => {
  beforeEach(() => {
    backing.clear();
  });

  it("returns the fallback when the key is absent", async () => {
    const { readJson } = await loadStoreWithRedis();
    expect(await readJson("missing.json", { a: 1 })).toEqual({ a: 1 });
  });

  it("round-trips a value through Redis under a namespaced key", async () => {
    const { readJson, writeJson } = await loadStoreWithRedis();
    await writeJson("verifications.json", { "0xabc": { "1": "ok" } });
    expect(await readJson("verifications.json", {})).toEqual({
      "0xabc": { "1": "ok" },
    });
    // Key is namespaced so it can't collide with other projects' data.
    expect(backing.has("gohealthme:verifications.json")).toBe(true);
  });
});
