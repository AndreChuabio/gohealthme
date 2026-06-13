"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import Countdown from "@/components/Countdown";
import { Badge, EmptyState, ErrorNote, Skeleton } from "@/components/ui";
import {
  fetchParticipant,
  fetchPools,
  formatUsdc,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";

interface JoinedPool {
  pool: PoolInfo;
  participant: ParticipantInfo;
}

interface WhoopProgress {
  connected: boolean;
  metric: string | null;
  streakDays: number | null;
  targetDays: number | null;
  lastSync: string | null;
}

type WhoopState =
  | { kind: "ok"; progress: WhoopProgress }
  | { kind: "unavailable"; reason: string };

function parseWhoopProgress(payload: unknown): WhoopProgress {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  return {
    connected: record.connected === true,
    metric: typeof record.metric === "string" ? record.metric : null,
    streakDays:
      typeof record.streakDays === "number" ? record.streakDays : null,
    targetDays:
      typeof record.targetDays === "number" ? record.targetDays : null,
    lastSync: typeof record.lastSync === "string" ? record.lastSync : null,
  };
}

async function fetchWhoopProgress(): Promise<WhoopState> {
  try {
    const res = await fetch("/api/whoop/progress");
    if (!res.ok) {
      return {
        kind: "unavailable",
        reason:
          res.status === 404
            ? "The WHOOP progress feed is not live yet."
            : `WHOOP progress feed responded ${res.status}.`,
      };
    }
    return { kind: "ok", progress: parseWhoopProgress(await res.json()) };
  } catch {
    return {
      kind: "unavailable",
      reason: "Could not reach the WHOOP progress feed.",
    };
  }
}

async function fetchJoinedPools(address: `0x${string}`): Promise<JoinedPool[]> {
  const pools = await fetchPools();
  const participants = await Promise.all(
    pools.map((pool) => fetchParticipant(pool.id, address)),
  );
  return pools
    .map((pool, i) => ({ pool, participant: participants[i] }))
    .filter((entry) => entry.participant.joined);
}

function resultLabel(p: ParticipantInfo): { text: string; tone: "accent" | "muted" | "warning" } {
  if (!p.resultRecorded) return { text: "Pending verification", tone: "warning" };
  if (p.verdict) {
    const multiplier = (p.multiplierBps / 10_000).toFixed(2);
    return { text: `Achieved at ${multiplier}x`, tone: "accent" };
  }
  return { text: "Goal missed", tone: "muted" };
}

function StreakCard() {
  const whoopQuery = useQuery({
    queryKey: ["whoop-progress"],
    queryFn: fetchWhoopProgress,
    retry: false,
  });

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">Streak progress</h2>
      {whoopQuery.isLoading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : whoopQuery.data === undefined ||
        whoopQuery.data.kind === "unavailable" ? (
        <p className="mt-3 rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
          {whoopQuery.data?.kind === "unavailable"
            ? whoopQuery.data.reason
            : "Streak feed unavailable."}{" "}
          Connect your wearable to see verified streak progress here.
        </p>
      ) : !whoopQuery.data.progress.connected ? (
        <p className="mt-3 rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
          No wearable connected yet. Link WHOOP to start tracking your streak
          toward the bounty.
        </p>
      ) : (
        <div className="mt-3">
          <p className="text-3xl font-bold text-accent">
            {whoopQuery.data.progress.streakDays ?? 0}
            <span className="text-lg font-semibold text-foreground">
              {whoopQuery.data.progress.targetDays !== null
                ? ` of ${whoopQuery.data.progress.targetDays} days`
                : " days"}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {whoopQuery.data.progress.metric ?? "Verified streak"}
            {whoopQuery.data.progress.lastSync !== null
              ? ` · last sync ${whoopQuery.data.progress.lastSync}`
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}

export default function DashboardContent() {
  const { ready, authenticated, address, login } = useEmbeddedWallet();

  const joinedQuery = useQuery({
    queryKey: ["joined-pools", address],
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchJoinedPools(address);
    },
    enabled: address !== null,
  });

  if (!ready) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!authenticated || address === null) {
    return (
      <EmptyState
        title="Sign in to see your goals"
        detail="Your joined pools, streak progress, and payouts live here once you sign in."
        action={
          <button
            type="button"
            onClick={login}
            className="rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
          >
            Sign in
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <StreakCard />

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Joined pools</h2>
        {joinedQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : joinedQuery.isError ? (
          <ErrorNote
            title="Could not load your pools"
            detail={
              joinedQuery.error instanceof Error
                ? joinedQuery.error.message
                : "Unknown error reading from Arc testnet."
            }
            onRetry={() => {
              void joinedQuery.refetch();
            }}
          />
        ) : (joinedQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="You have not joined a pool yet"
            detail="Pick a sponsor-funded goal, verify with World ID, and start earning."
            action={
              <Link
                href="/pools"
                className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
              >
                Browse pools
              </Link>
            }
          />
        ) : (
          (joinedQuery.data ?? []).map(({ pool, participant }) => {
            const result = resultLabel(participant);
            return (
              <Link
                key={pool.id.toString()}
                href={`/pools/${pool.id.toString()}`}
                className="block rounded-2xl border border-edge bg-surface p-5 transition-colors hover:border-accent/50"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge>{pool.initiative}</Badge>
                  <Badge tone={result.tone}>{result.text}</Badge>
                </div>
                <h3 className="mt-3 text-lg font-semibold leading-snug">
                  {pool.goalSpec}
                </h3>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
                  <span>
                    Bounty pool{" "}
                    <span className="font-semibold text-accent">
                      {formatUsdc(pool.balance)} USDC
                    </span>
                  </span>
                  <span>
                    Backed with{" "}
                    <span className="font-semibold text-foreground">
                      {formatUsdc(participant.backingTotal)} USDC
                    </span>
                  </span>
                  <Countdown
                    periodStart={pool.periodStart}
                    periodEnd={pool.periodEnd}
                  />
                </div>
              </Link>
            );
          })
        )}
      </section>
    </div>
  );
}
