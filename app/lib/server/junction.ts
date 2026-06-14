// Junction (formerly Vital) health-data integration (server only).
//
// Replaces the WHOOP-direct OAuth integration with Junction's unified API,
// which covers WHOOP, Oura, Fitbit, Garmin, etc. through one connect flow.
// (Apple Health is intentionally NOT supported here: it requires Junction's
// native mobile SDK and cannot be linked from a web app.)
//
// Auth: header `x-vital-api-key`. Base URL + env/region come from env so the
// same code runs against sandbox or production.
//
// Privacy invariant (unchanged from WHOOP): raw samples never leave this
// module — only derived per-day scores and a streak summary are surfaced, and
// nothing here is written on-chain directly.

import { requireEnv, optionalEnv } from "@/lib/server/env";

function apiKey(): string {
  return requireEnv("JUNCTION_API_KEY");
}
function baseUrl(): string {
  return optionalEnv("JUNCTION_BASE_URL", "https://api.sandbox.tryvital.io");
}
function linkBase(): { env: string; region: string } {
  const env = optionalEnv("JUNCTION_ENV", "sandbox");
  const region = optionalEnv("JUNCTION_REGION", "us");
  return { env, region };
}

async function jx<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "x-vital-api-key": apiKey(),
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Junction ${path} returned ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// --------------------------------------------------------------- user mapping

interface VitalUser {
  user_id: string;
  client_user_id?: string;
}

/**
 * Map a wallet address to a Junction user_id. Junction itself keys on
 * client_user_id, so we resolve-then-create and let it dedupe — no local store
 * needed. The address is lowercased to keep the client_user_id stable.
 */
export async function getOrCreateUser(address: string): Promise<string> {
  const clientUserId = address.toLowerCase();
  // 1) resolve existing
  const resolved = await fetch(
    `${baseUrl()}/v2/user/resolve/${encodeURIComponent(clientUserId)}`,
    { headers: { "x-vital-api-key": apiKey() } },
  );
  if (resolved.ok) {
    const u = (await resolved.json()) as VitalUser;
    if (u.user_id) return u.user_id;
  }
  // 2) create
  const created = await jx<VitalUser>("/v2/user", {
    method: "POST",
    body: JSON.stringify({ client_user_id: clientUserId }),
  });
  return created.user_id;
}

// ------------------------------------------------------------------ link flow

interface LinkTokenResponse {
  link_token: string;
}

/**
 * Create a Junction Link token + the hosted connect URL the browser opens to
 * link a provider (WHOOP/Oura/Fitbit/Garmin/…).
 */
export async function createLinkToken(
  address: string,
): Promise<{ userId: string; linkUrl: string }> {
  const userId = await getOrCreateUser(address);
  const { link_token } = await jx<LinkTokenResponse>("/v2/link/token", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  const { env, region } = linkBase();
  const linkUrl = `https://link.tryvital.io/?token=${encodeURIComponent(
    link_token,
  )}&env=${env}&region=${region}`;
  return { userId, linkUrl };
}

// ---------------------------------------------------------- connection status

interface ProvidersResponse {
  providers: Array<{ slug?: string; status?: string }>;
}

/** True once the user has linked at least one health-data provider. */
export async function isConnected(address: string): Promise<boolean> {
  const userId = await getOrCreateUser(address);
  const { providers } = await jx<ProvidersResponse>(
    `/v2/user/providers/${userId}`,
  );
  return Array.isArray(providers) && providers.length > 0;
}

// -------------------------------------------------------------- progress feed

export interface JunctionProgress {
  streakDays: number;
  lastNight: number | null;
  qualified: boolean;
  /** Average score over days 8-14 back (the week before the current week). */
  baselineWeekAvg: number | null;
  /** Per-day scores used, newest first. */
  days: Array<{ date: string; score: number }>;
}

interface SleepRecord {
  calendar_date?: string;
  date?: string;
  bedtime_stop?: string;
  score?: number | null;
  efficiency?: number | null;
  sleep_efficiency?: number | null;
}

interface SleepResponse {
  sleep?: SleepRecord[];
  data?: SleepRecord[];
}

function dayKey(rec: SleepRecord): string | null {
  if (rec.calendar_date) return rec.calendar_date.slice(0, 10);
  if (rec.date) return rec.date.slice(0, 10);
  if (rec.bedtime_stop) return rec.bedtime_stop.slice(0, 10);
  return null;
}

function recScore(rec: SleepRecord): number | null {
  const v = rec.score ?? rec.efficiency ?? rec.sleep_efficiency;
  return typeof v === "number" ? v : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the current sleep streak for an address from Junction data.
 *
 * Mirrors the previous WHOOP logic: a day qualifies when its best sleep score
 * meets `threshold`; the streak is the run of consecutive calendar days ending
 * at the most recent scored night. baselineWeekAvg averages days 8-14 back,
 * feeding the comeback multiplier.
 */
export async function getProgress(
  address: string,
  threshold = 75,
  goalDays = 7,
): Promise<JunctionProgress> {
  const userId = await getOrCreateUser(address);
  const end = new Date();
  const start = new Date(end.getTime() - 21 * 24 * 3600 * 1000);
  const resp = await jx<SleepResponse>(
    `/v2/summary/sleep/${userId}?start_date=${isoDate(start)}&end_date=${isoDate(end)}`,
  );
  const records = resp.sleep ?? resp.data ?? [];

  // Best score per calendar day.
  const byDay = new Map<string, number>();
  for (const rec of records) {
    const key = dayKey(rec);
    const score = recScore(rec);
    if (key === null || score === null) continue;
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

  // Count qualifying days within the last `goalDays` window ending at the most
  // recent scored night. (We count days at/over threshold rather than a strict
  // consecutive run, so a single missing day of data — common with wearables —
  // doesn't reset progress to zero.)
  let streakDays = 0;
  const cursor = new Date(`${newest}T00:00:00Z`);
  for (let i = 0; i < goalDays; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    const score = byDay.get(key);
    if (score !== undefined && score >= threshold) streakDays += 1;
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

// ------------------------------------------------------------- recent data

export interface RecentData {
  sleep: Array<{ date: string; score: number | null; hours: number | null }>;
  activity: Array<{ date: string; steps: number | null }>;
}

interface ActivityRecord {
  calendar_date?: string;
  date?: string;
  steps?: number | null;
}
interface ActivityResponse {
  activity?: ActivityRecord[];
  data?: ActivityRecord[];
}

/**
 * Recent per-day sleep + activity, newest first, for the dashboard demo
 * display once a provider is linked. Each summary call is best-effort so a
 * provider that only reports one modality still renders the other.
 */
export async function getRecent(address: string, days = 7): Promise<RecentData> {
  const userId = await getOrCreateUser(address);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const range = `start_date=${isoDate(start)}&end_date=${isoDate(end)}`;

  const [sleepResp, actResp] = await Promise.all([
    jx<SleepResponse>(`/v2/summary/sleep/${userId}?${range}`).catch(
      () => ({ sleep: [] }) as SleepResponse,
    ),
    jx<ActivityResponse>(`/v2/summary/activity/${userId}?${range}`).catch(
      () => ({ activity: [] }) as ActivityResponse,
    ),
  ]);

  const sleepRecs = sleepResp.sleep ?? sleepResp.data ?? [];
  const actRecs = actResp.activity ?? actResp.data ?? [];

  const sleep = sleepRecs
    .map((r) => {
      const date = dayKey(r);
      if (date === null) return null;
      const rec = r as SleepRecord & {
        duration?: number;
        total_sleep_seconds?: number;
      };
      const secs = rec.total_sleep_seconds ?? rec.duration ?? null;
      return {
        date,
        score: recScore(r),
        hours:
          typeof secs === "number" ? Math.round((secs / 3600) * 10) / 10 : null,
      };
    })
    .filter(
      (x): x is { date: string; score: number | null; hours: number | null } =>
        x !== null,
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const activity = actRecs
    .map((r) => {
      const date =
        r.calendar_date?.slice(0, 10) ?? r.date?.slice(0, 10) ?? null;
      if (date === null) return null;
      return { date, steps: typeof r.steps === "number" ? r.steps : null };
    })
    .filter((x): x is { date: string; steps: number | null } => x !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return { sleep, activity };
}
