"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import Countdown from "@/components/Countdown";
import JoinPool from "@/components/JoinPool";
import BackGoal from "@/components/BackGoal";
import FundPool from "@/components/FundPool";
import { Badge, ErrorNote, Skeleton, Stat } from "@/components/ui";
import { arcAddressUrl } from "@/lib/chains";
import {
  BOUNTY_MODEL_LABELS,
  fetchParticipants,
  fetchPool,
  formatUsdc,
  shortAddress,
} from "@/lib/contract";

function formatDate(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PoolDetail({ id }: { id: string }) {
  const poolId = useMemo(() => {
    try {
      const parsed = BigInt(id);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [id]);

  const poolQuery = useQuery({
    queryKey: ["pool", id],
    queryFn: () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      return fetchPool(poolId);
    },
    enabled: poolId !== null,
  });

  const participantsQuery = useQuery({
    queryKey: ["participants", id],
    queryFn: () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      return fetchParticipants(poolId);
    },
    enabled: poolId !== null,
  });

  if (poolId === null) {
    return (
      <ErrorNote
        title="Invalid pool"
        detail={`"${id}" is not a valid pool id.`}
      />
    );
  }

  if (poolQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-3/4" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-14" />
      </div>
    );
  }

  if (poolQuery.isError || poolQuery.data === undefined) {
    return (
      <ErrorNote
        title="Could not load this pool"
        detail={
          poolQuery.error instanceof Error
            ? poolQuery.error.message
            : "Unknown error reading from Arc testnet."
        }
        onRetry={() => {
          void poolQuery.refetch();
        }}
      />
    );
  }

  const pool = poolQuery.data;
  const participantCount = participantsQuery.data?.length ?? null;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{pool.initiative}</Badge>
          {pool.settled ? (
            <Badge tone="muted">Settled</Badge>
          ) : (
            <Badge tone="warning">Live</Badge>
          )}
        </div>
        <h1 className="mt-3 text-2xl font-bold leading-tight sm:text-3xl">
          {pool.goalSpec}
        </h1>
        <p className="mt-2 text-sm text-muted">
          Sponsored by{" "}
          <a
            href={arcAddressUrl(pool.creator)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono underline decoration-edge underline-offset-2 hover:text-foreground"
          >
            {shortAddress(pool.creator)}
          </a>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Bounty pool"
          value={
            <span className="text-accent">{formatUsdc(pool.balance)} USDC</span>
          }
        />
        <Stat label="Entry fee" value={`${formatUsdc(pool.entryFee)} USDC`} />
        <Stat
          label="Time remaining"
          value={
            <Countdown
              periodStart={pool.periodStart}
              periodEnd={pool.periodEnd}
            />
          }
        />
        <Stat
          label="Payout model"
          value={BOUNTY_MODEL_LABELS[pool.bountyModel] ?? "Unknown"}
        />
        <Stat
          label="Participants"
          value={participantCount !== null ? participantCount : "--"}
        />
        <Stat
          label="Period"
          value={`${formatDate(pool.periodStart)} to ${formatDate(pool.periodEnd)}`}
        />
      </div>

      {!pool.settled ? (
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <h2 className="text-lg font-semibold">Join this pool</h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            Pay the {formatUsdc(pool.entryFee)} USDC entry fee, hit the goal
            during the period, and the bounty pays out the moment your result
            is verified.
          </p>
          <JoinPool poolId={pool.id} />
        </section>
      ) : (
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <h2 className="text-lg font-semibold">This pool has settled</h2>
          <p className="mt-1 text-sm text-muted">
            Bounties were paid to verified achievers. Browse other pools to
            join a live one.
          </p>
        </section>
      )}

      {!pool.settled ? (
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <BackGoal poolId={pool.id} />
        </section>
      ) : null}

      <section className="rounded-2xl border border-edge bg-surface p-5">
        <FundPool poolId={pool.id} />
      </section>
    </div>
  );
}
