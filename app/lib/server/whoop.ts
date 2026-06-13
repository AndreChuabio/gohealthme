// WHOOP API v2 integration (server only).
//
// Verified from live docs (developer.whoop.com, fetched Jun 12 2026):
//   - Authorize URL:  https://api.prod.whoop.com/oauth/oauth2/auth
//   - Token URL:      https://api.prod.whoop.com/oauth/oauth2/token
//   - Sleep list:     GET /developer/v2/activity/sleep?limit&start&end&nextToken (limit max 25)
//   - Scopes:         read:sleep read:recovery offline (offline => refresh_token issued)
//   - Sleep record:   { start, end, nap, score_state, score: { sleep_performance_percentage, ... } }
//   - Refreshing a token invalidates the old access token; new refresh_token is returned.
//   - OAuth state must be at least 8 characters.
//
// Privacy invariant: raw sleep data never leaves this module except as
// per-day performance scores; nothing here goes on-chain directly.

import { requireEnv } from "@/lib/server/env";
import { readJson, writeJson } from "@/lib/server/store";

const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_SLEEP_URL = "https://api.prod.whoop.com/developer/v2/activity/sleep";
const WHOOP_SCOPES = "read:sleep read:recovery offline";

const TOKENS_FILE = "whoop-tokens.json";

export interface WhoopTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface SleepRecord {
  id: string;
  start: string;
  end: string;
  nap: boolean;
  score_state: string;
  score?: {
    sleep_performance_percentage?: number;
  };
}

interface SleepPage {
  records: SleepRecord[];
  next_token?: string | null;
}

export interface WhoopProgress {
  streakDays: number;
  lastNight: number | null;
  qualified: boolean;
  /** Average score over days 8-14 back (the week before the current week). */
  baselineWeekAvg: number | null;
  /** Per-day scores used, newest first, for the frontend to chart. */
  days: Array<{ date: string; score: number }>;
}

export function buildAuthorizeUrl(state: string): string {
  const clientId = requireEnv("WHOOP_CLIENT_ID");
  const redirectUri = requireEnv("WHOOP_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: WHOOP_SCOPES,
    state,
  });
  return `${WHOOP_AUTH_URL}?${params.toString()}`;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WHOOP token endpoint returned ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCode(code: string): Promise<WhoopTokens> {
  const data = await requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: requireEnv("WHOOP_CLIENT_ID"),
      client_secret: requireEnv("WHOOP_CLIENT_SECRET"),
      redirect_uri: requireEnv("WHOOP_REDIRECT_URI"),
    }),
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function refreshTokens(tokens: WhoopTokens): Promise<WhoopTokens> {
  const data = await requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: requireEnv("WHOOP_CLIENT_ID"),
      client_secret: requireEnv("WHOOP_CLIENT_SECRET"),
      scope: "offline",
    }),
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

type TokenMap = Record<string, WhoopTokens>;

export async function saveTokensForAddress(
  address: string,
  tokens: WhoopTokens,
): Promise<void> {
  const map = await readJson<TokenMap>(TOKENS_FILE, {});
  map[address.toLowerCase()] = tokens;
  await writeJson(TOKENS_FILE, map);
}

export async function getTokensForAddress(
  address: string,
): Promise<WhoopTokens | null> {
  const map = await readJson<TokenMap>(TOKENS_FILE, {});
  return map[address.toLowerCase()] ?? null;
}

async function getFreshTokens(address: string): Promise<WhoopTokens> {
  let tokens = await getTokensForAddress(address);
  if (tokens === null) {
    throw new Error(
      `No WHOOP connection for ${address}. Visit /api/whoop/login?address=${address} first.`,
    );
  }
  // Refresh 60s before expiry to avoid edge-of-expiry 401s.
  if (tokens.expiresAt - 60_000 < Date.now()) {
    tokens = await refreshTokens(tokens);
    await saveTokensForAddress(address, tokens);
  }
  return tokens;
}

async function fetchSleepRecords(
  accessToken: string,
  sinceIso: string,
): Promise<SleepRecord[]> {
  const records: SleepRecord[] = [];
  let nextToken: string | undefined;
  // Two pages of 25 covers a 21-day window comfortably.
  for (let page = 0; page < 2; page += 1) {
    const params = new URLSearchParams({ limit: "25", start: sinceIso });
    if (nextToken !== undefined) params.set("nextToken", nextToken);
    const res = await fetch(`${WHOOP_SLEEP_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WHOOP sleep endpoint returned ${res.status}: ${text}`);
    }
    const data = (await res.json()) as SleepPage;
    records.push(...data.records);
    if (data.next_token === undefined || data.next_token === null) break;
    nextToken = data.next_token;
  }
  return records;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Compute current sleep streak for an address.
 *
 * A day counts when its main (non-nap) scored sleep has
 * sleep_performance_percentage >= threshold. The streak is the run of
 * consecutive calendar days ending at the most recent scored night.
 * baselineWeekAvg averages days 8-14 back relative to the most recent
 * night, used for the comeback multiplier.
 */
export async function getProgress(
  address: string,
  threshold = 75,
  goalDays = 7,
): Promise<WhoopProgress> {
  const tokens = await getFreshTokens(address);
  const since = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString();
  const records = await fetchSleepRecords(tokens.accessToken, since);

  // Best score per calendar day (night assigned to the date the sleep ended).
  const byDay = new Map<string, number>();
  for (const rec of records) {
    if (rec.nap) continue;
    if (rec.score_state !== "SCORED") continue;
    const score = rec.score?.sleep_performance_percentage;
    if (typeof score !== "number") continue;
    const key = dayKey(rec.end);
    const prev = byDay.get(key);
    if (prev === undefined || score > prev) byDay.set(key, score);
  }

  const dates = Array.from(byDay.keys()).sort().reverse(); // newest first
  if (dates.length === 0) {
    return {
      streakDays: 0,
      lastNight: null,
      qualified: false,
      baselineWeekAvg: null,
      days: [],
    };
  }

  const newest = dates[0];
  const lastNight = byDay.get(newest) ?? null;

  // Walk back day by day from the newest scored night.
  let streakDays = 0;
  const cursor = new Date(`${newest}T00:00:00Z`);
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    const score = byDay.get(key);
    if (score === undefined || score < threshold) break;
    streakDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // Baseline week: days 8..14 back from the newest night.
  const baselineScores: number[] = [];
  for (let back = 7; back < 14; back += 1) {
    const d = new Date(`${newest}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    const score = byDay.get(d.toISOString().slice(0, 10));
    if (score !== undefined) baselineScores.push(score);
  }
  const baselineWeekAvg =
    baselineScores.length > 0
      ? baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length
      : null;

  return {
    streakDays,
    lastNight,
    qualified: streakDays >= goalDays,
    baselineWeekAvg,
    days: dates.map((d) => ({ date: d, score: byDay.get(d) as number })),
  };
}
