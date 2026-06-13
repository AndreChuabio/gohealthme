"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Address } from "viem";
import { arcTxUrl } from "@/lib/chains";
import { PRIVY_CONFIGURED } from "@/lib/config";
import {
  erc20Abi,
  fetchParticipants,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  parseUsdc,
  shortAddress,
  USDC_ADDRESS,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { ErrorNote } from "@/components/ui";

type BackStatus =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "backing" }
  | { kind: "done"; txHash: string }
  | { kind: "error"; message: string };

function BackGoalInner({ poolId }: { poolId: bigint }) {
  const { ready, authenticated, address, login, getArcWalletClient } =
    useEmbeddedWallet();
  const queryClient = useQueryClient();
  const [participant, setParticipant] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [status, setStatus] = useState<BackStatus>({ kind: "idle" });

  const participantsQuery = useQuery({
    queryKey: ["participants", poolId.toString()],
    queryFn: () => fetchParticipants(poolId),
  });

  const poolsAddress = getHealthPoolsAddress();
  if (poolsAddress === null) {
    return (
      <ErrorNote
        title="Contract not configured"
        detail="Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS to enable backing."
      />
    );
  }

  const submit = async () => {
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(participant)) {
        throw new Error("Choose a participant to back.");
      }
      const parsedAmount = parseUsdc(amount.trim());
      if (parsedAmount <= 0n) {
        throw new Error("Enter a USDC amount greater than zero.");
      }
      const user = participant as Address;
      const walletClient = await getArcWalletClient();
      const publicClient = getArcPublicClient();

      setStatus({ kind: "approving" });
      const approveHash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [poolsAddress, parsedAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStatus({ kind: "backing" });
      const backHash = await walletClient.writeContract({
        address: poolsAddress,
        abi: healthPoolsAbi,
        functionName: "backGoal",
        args: [poolId, user, parsedAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: backHash });

      setStatus({ kind: "done", txHash: backHash });
      setAmount("");
      await queryClient.invalidateQueries({ queryKey: ["pool"] });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Backing transaction failed.",
      });
    }
  };

  const busy = status.kind === "approving" || status.kind === "backing";
  const participants = participantsQuery.data ?? [];

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Back this goal</h3>
      <p className="text-sm text-muted">
        Stake USDC behind a participant. If they hit the goal you get your
        stake back plus a 20 percent bonus from the pool; if they miss, your
        stake rolls into the bounty.
      </p>

      {participantsQuery.isLoading ? (
        <div className="h-12 animate-pulse rounded-xl bg-surface-raised" />
      ) : participantsQuery.isError ? (
        <ErrorNote
          title="Could not load participants"
          detail={
            participantsQuery.error instanceof Error
              ? participantsQuery.error.message
              : undefined
          }
          onRetry={() => {
            void participantsQuery.refetch();
          }}
        />
      ) : participants.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
          No participants have joined yet. Backing opens once the first person
          joins.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium">
            Participant
            <select
              value={participant}
              onChange={(e) => setParticipant(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            >
              <option value="">Select a participant</option>
              {participants.map((p) => (
                <option key={p} value={p}>
                  {address !== null && p.toLowerCase() === address.toLowerCase()
                    ? `${shortAddress(p)} (you)`
                    : shortAddress(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Amount (USDC)
            <input
              type="text"
              inputMode="decimal"
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            />
          </label>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => {
              if (!authenticated) {
                login();
                return;
              }
              void submit();
            }}
            className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3.5 text-base font-semibold text-accent hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status.kind === "approving"
              ? "Approving USDC..."
              : status.kind === "backing"
                ? "Staking behind goal..."
                : authenticated
                  ? "Approve and back goal"
                  : "Sign in to back"}
          </button>
        </>
      )}

      {status.kind === "done" ? (
        <div className="rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
          <p className="text-sm font-semibold text-accent">
            Stake placed behind the goal.
          </p>
          <a
            href={arcTxUrl(status.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-sm text-accent underline"
          >
            View transaction on Arcscan
          </a>
        </div>
      ) : null}
      {status.kind === "error" ? (
        <ErrorNote
          title="Backing failed"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
    </div>
  );
}

export default function BackGoal({ poolId }: { poolId: bigint }) {
  if (!PRIVY_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_PRIVY_APP_ID to enable backing with an embedded wallet."
      />
    );
  }
  return <BackGoalInner poolId={poolId} />;
}
