"use client";

import { useState } from "react";
import { useEmbeddedWallet } from "@/lib/wallet";

type Phase =
  | "idle"
  | "provisioning"
  | "claiming"
  | "done"
  | "withdrawing"
  | "withdrawn"
  | "error";

async function postJson(
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Request failed",
    );
  }
  return data;
}

export default function ClaimPrivately({
  poolId,
  rewardUsdc = "0.25",
}: {
  poolId: string;
  rewardUsdc?: string;
}) {
  const { address, authenticated } = useEmbeddedWallet();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const busy =
    phase === "provisioning" || phase === "claiming" || phase === "withdrawing";

  async function claim() {
    setError(null);
    if (!authenticated || address === null) {
      setError("Sign in first.");
      setPhase("error");
      return;
    }
    try {
      setPhase("provisioning");
      await postJson("/api/unlink/account", { address });

      setPhase("claiming");
      const goalId = `pool-${poolId}-${address}`;
      await postJson("/api/unlink/payout", {
        address,
        poolId,
        goalId,
        rewardUsdc,
      });
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function withdraw() {
    setError(null);
    if (address === null) return;
    try {
      setPhase("withdrawing");
      await postJson("/api/unlink/withdraw", { address, amountUsdc: rewardUsdc });
      setPhase("withdrawn");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div className="rounded-2xl border border-accent/40 bg-surface p-5">
      <h2 className="text-lg font-semibold">Receive this reward privately</h2>
      <p className="mb-4 mt-1 text-sm text-muted">
        Paid into your private Unlink account on Arc, then withdrawn to a wallet
        of your choice. There is no on-chain link between this health goal and
        the wallet that receives the funds.
      </p>

      {phase !== "done" && phase !== "withdrawn" && phase !== "withdrawing" ? (
        <button
          type="button"
          onClick={() => {
            void claim();
          }}
          disabled={busy}
          className="rounded-xl bg-accent-strong px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
        >
          {phase === "provisioning"
            ? "Setting up private account…"
            : phase === "claiming"
              ? "Sending private payment…"
              : `Claim ${rewardUsdc} USDC privately`}
        </button>
      ) : null}

      {phase === "done" || phase === "withdrawing" || phase === "withdrawn" ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
            Reward delivered to your private account. The transfer is shielded —
            the source can&apos;t be tied to this pool.
          </p>
          {phase !== "withdrawn" ? (
            <button
              type="button"
              onClick={() => {
                void withdraw();
              }}
              disabled={phase === "withdrawing"}
              className="rounded-xl border border-edge px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {phase === "withdrawing" ? "Withdrawing…" : "Withdraw to my wallet"}
            </button>
          ) : (
            <p className="text-sm text-accent">
              Withdrawn to your wallet. Done — privately.
            </p>
          )}
        </div>
      ) : null}

      {error !== null ? (
        <p className="mt-3 text-sm text-danger">{error}</p>
      ) : null}
    </div>
  );
}
