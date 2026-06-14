"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import BlinkTopUp from "@/components/BlinkTopUp";
import { BLINK_CONFIGURED } from "@/lib/blink";
import { arcTxUrl } from "@/lib/chains";
import { formatUsdc } from "@/lib/contract";
import { ErrorNote } from "@/components/ui";

/**
 * GoHealthMe balance card. Blink tops up an in-app USDC balance (USDC lands at
 * the merchant address on Base Sepolia); moving it to the Arc wallet has the
 * treasury deliver the same amount of spendable Arc USDC, which the existing
 * join/fund/back flows then pull from. Blink is the funding UX; Arc settlement
 * is unchanged.
 */

interface BalanceResponse {
  balanceUusdc?: string;
}

async function fetchBalanceUusdc(address: string): Promise<bigint> {
  const res = await fetch(`/api/balance?address=${address}`);
  if (!res.ok) {
    throw new Error(`Balance feed responded ${res.status}.`);
  }
  const body = (await res.json()) as BalanceResponse;
  return BigInt(body.balanceUusdc ?? "0");
}

type MoveStatus =
  | { kind: "idle" }
  | { kind: "moving" }
  | { kind: "done"; txHash: string }
  | { kind: "error"; message: string };

export default function BalanceCard({ address }: { address: `0x${string}` }) {
  const queryClient = useQueryClient();
  const [move, setMove] = useState<MoveStatus>({ kind: "idle" });

  const balanceQuery = useQuery({
    queryKey: ["balance", address],
    queryFn: () => fetchBalanceUusdc(address),
    retry: false,
  });

  const balance = balanceQuery.data ?? 0n;

  const refreshBalance = async () => {
    await queryClient.invalidateQueries({ queryKey: ["balance", address] });
  };

  // A confirmed Blink deposit credits the ledger; then refresh the displayed
  // balance. Failure here is non-fatal -- the deposit settled on Base either
  // way, and the confirm route is idempotent on retry by the Blink tx hash.
  const confirmTopUp = (result: { txHash: string; amountUusdc: number }) => {
    void (async () => {
      try {
        await fetch("/api/balance/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address,
            blinkTxHash: result.txHash,
            amountUusdc: result.amountUusdc.toString(),
          }),
        });
        await refreshBalance();
      } catch (err) {
        console.error("[balance] top-up confirm failed", err);
      }
    })();
  };

  const moveToArc = async () => {
    if (balance <= 0n) return;
    setMove({ kind: "moving" });
    try {
      const ref = crypto.randomUUID();
      const res = await fetch("/api/balance/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          amountUusdc: balance.toString(),
          ref,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        txHash?: string;
        error?: string;
      };
      if (!res.ok || typeof body.txHash !== "string") {
        throw new Error(body.error ?? `Move failed with status ${res.status}.`);
      }
      setMove({ kind: "done", txHash: body.txHash });
      await refreshBalance();
    } catch (err) {
      setMove({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Move to Arc wallet failed.",
      });
    }
  };

  const moving = move.kind === "moving";

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">GoHealthMe balance</h2>
      <p className="mt-3 text-3xl font-bold text-accent">
        {formatUsdc(balance)}
        <span className="ml-1 text-lg font-semibold text-foreground">USDC</span>
      </p>
      <p className="mt-1 text-sm text-muted">
        Top up in one tap with Blink, then move it to your Arc wallet to back
        goals and fund pools.
      </p>

      {BLINK_CONFIGURED ? (
        <div className="mt-4">
          <BlinkTopUp address={address} onConfirmed={confirmTopUp} />
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-edge p-3 text-sm text-muted">
          Blink top-up is not configured. Set NEXT_PUBLIC_BLINK_USDC_ADDRESS and
          NEXT_PUBLIC_BLINK_MERCHANT_ADDRESS to enable one-tap funding.
        </p>
      )}

      <button
        type="button"
        disabled={balance <= 0n || moving}
        onClick={() => {
          void moveToArc();
        }}
        className="mt-3 w-full rounded-xl bg-accent-strong px-5 py-3 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {moving ? "Moving to Arc wallet..." : "Move balance to Arc wallet"}
      </button>

      {move.kind === "done" ? (
        <div className="mt-2 rounded-xl border border-accent/40 bg-accent-deep/40 p-3">
          <p className="text-sm font-semibold text-accent">
            Moved to your Arc wallet. It is now spendable on goals and pools.
          </p>
          <a
            href={arcTxUrl(move.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-sm text-accent underline"
          >
            View transfer on Arcscan
          </a>
        </div>
      ) : null}
      {move.kind === "error" ? (
        <ErrorNote
          title="Could not move your balance"
          detail={move.message}
          onRetry={() => setMove({ kind: "idle" })}
        />
      ) : null}
    </section>
  );
}
