import Link from "next/link";
import Countdown from "@/components/Countdown";
import { Badge } from "@/components/ui";
import {
  BOUNTY_MODEL_LABELS,
  formatUsdc,
  shortAddress,
  type PoolInfo,
} from "@/lib/contract";

export default function PoolCard({ pool }: { pool: PoolInfo }) {
  return (
    <Link
      href={`/pools/${pool.id.toString()}`}
      className="block rounded-2xl border border-edge bg-surface p-5 transition-colors hover:border-accent/50"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>{pool.initiative}</Badge>
        {pool.settled ? <Badge tone="muted">Settled</Badge> : null}
      </div>
      <h3 className="mt-3 text-xl font-semibold leading-snug">
        {pool.goalSpec}
      </h3>
      <p className="mt-1 text-xs text-muted">
        Funder {shortAddress(pool.creator)} ·{" "}
        {BOUNTY_MODEL_LABELS[pool.bountyModel] ?? "Custom model"}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface-raised p-3">
          <p className="text-xs uppercase tracking-wide text-muted">Bounty pool</p>
          <p className="mt-0.5 text-lg font-bold text-accent">
            {formatUsdc(pool.balance)} USDC
          </p>
        </div>
        <div className="rounded-xl bg-surface-raised p-3">
          <p className="text-xs uppercase tracking-wide text-muted">Entry fee</p>
          <p className="mt-0.5 text-lg font-bold">
            {formatUsdc(pool.entryFee)} USDC
          </p>
        </div>
      </div>
      <p className="mt-3 text-sm font-medium">
        <Countdown periodStart={pool.periodStart} periodEnd={pool.periodEnd} />
      </p>
    </Link>
  );
}
