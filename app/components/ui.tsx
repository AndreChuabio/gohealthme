import type { ReactNode } from "react";
import { arcTxUrl } from "@/lib/chains";

export function ArcTxLink({
  txHash,
  label = "View transaction on Arcscan",
}: {
  txHash: string;
  label?: string;
}) {
  return (
    <a
      href={arcTxUrl(txHash)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block break-all text-sm text-accent underline"
    >
      {label}
    </a>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-surface-raised ${className}`}
    />
  );
}

export function PoolCardSkeleton() {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-5">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="mt-4 h-7 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    </div>
  );
}

export function ErrorNote({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/40 bg-danger/10 p-4"
    >
      <p className="text-base font-semibold text-danger">{title}</p>
      {detail !== undefined && detail !== "" ? (
        <p className="mt-1 break-words text-sm text-foreground/80">{detail}</p>
      ) : null}
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-danger/50 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/20"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-edge bg-surface/50 px-6 py-12 text-center">
      <p className="text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{detail}</p>
      {action !== undefined ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "muted" | "warning";
}) {
  const tones: Record<string, string> = {
    accent: "bg-accent-deep text-accent border-accent/30",
    muted: "bg-surface-raised text-muted border-edge",
    warning: "bg-warning/10 text-warning border-warning/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-edge bg-surface-raised p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold leading-snug">{value}</p>
    </div>
  );
}
