"use client";

import { useEffect, useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { DYNAMIC_CONFIGURED, WORLD_ACTION_ID, WORLD_APP_ID } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  erc20Abi,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  USDC_ADDRESS,
} from "@/lib/contract";
import { ErrorNote } from "@/components/ui";

type JoinStatus =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "awaiting-proof" }
  | { kind: "verifying" }
  | { kind: "joining" }
  | { kind: "joined"; txHash: string | null }
  | { kind: "error"; message: string };

interface VerifyResponse {
  ok?: boolean;
  nullifierHash?: string;
  error?: string;
}

function parseRpContext(payload: unknown): RpContext | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const candidate =
    (record.rp_context as Record<string, unknown> | undefined) ??
    (record.rpContext as Record<string, unknown> | undefined) ??
    record;
  if (
    typeof candidate.rp_id === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.signature === "string" &&
    typeof candidate.created_at === "number" &&
    typeof candidate.expires_at === "number"
  ) {
    return {
      rp_id: candidate.rp_id,
      nonce: candidate.nonce,
      created_at: candidate.created_at,
      expires_at: candidate.expires_at,
      signature: candidate.signature,
    };
  }
  return null;
}

function JoinPoolInner({
  poolId,
  entryFee,
  alreadyJoined,
}: {
  poolId: bigint;
  entryFee: bigint;
  alreadyJoined: boolean;
}) {
  const { ready, authenticated, address, login, getArcWalletClient } =
    useEmbeddedWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JoinStatus>(
    alreadyJoined ? { kind: "joined", txHash: null } : { kind: "idle" },
  );

  // The on-chain participant read resolves async and after refresh. If it
  // confirms we are already a participant, show "You are in" instead of the
  // join button -- never clobber an in-flight join or a fresh success that
  // already carries its tx hash.
  useEffect(() => {
    if (alreadyJoined) {
      setStatus((s) => (s.kind === "idle" ? { kind: "joined", txHash: null } : s));
    }
  }, [alreadyJoined]);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);

  if (WORLD_APP_ID === null) {
    return (
      <ErrorNote
        title="World ID is not configured"
        detail="Set NEXT_PUBLIC_WORLD_APP_ID (must start with app_) to enable verified joining."
      />
    );
  }

  const startJoin = async () => {
    setStatus({ kind: "preparing" });
    try {
      const res = await fetch(`/api/world/rp-context?poolId=${poolId}`, {
        method: "GET",
      });
      if (!res.ok) {
        throw new Error(
          `Verification service responded ${res.status}. The /api/world/rp-context route may not be live yet.`,
        );
      }
      const context = parseRpContext(await res.json());
      if (context === null) {
        throw new Error(
          "Verification service returned an unexpected payload for the World ID request context.",
        );
      }
      setRpContext(context);
      setWidgetOpen(true);
      setStatus({ kind: "awaiting-proof" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to start World ID verification.",
      });
    }
  };

  const submitProof = async (result: IDKitResult) => {
    setWidgetOpen(false);
    setStatus({ kind: "verifying" });
    try {
      const res = await fetch("/api/world/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: result,
          poolId: poolId.toString(),
          address,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as VerifyResponse;
      if (!res.ok || body.ok !== true) {
        throw new Error(
          body.error ?? `Verification failed with status ${res.status}.`,
        );
      }
      if (
        typeof body.nullifierHash !== "string" ||
        body.nullifierHash.length === 0
      ) {
        throw new Error(
          "Verification succeeded but returned no nullifier hash.",
        );
      }

      // The proof is verified off-chain; now record the join on-chain. Without
      // this transaction the address is NOT a pool participant, so the oracle
      // cannot post a result and settle never pays out. The "joined" state is
      // only reached after this tx confirms.
      setStatus({ kind: "joining" });
      const poolsAddress = getHealthPoolsAddress();
      if (poolsAddress === null) {
        throw new Error(
          "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS.",
        );
      }
      const nullifier = BigInt(body.nullifierHash);
      const walletClient = await getArcWalletClient();
      const publicClient = getArcPublicClient();

      // Entry-fee pools pull USDC on join; approve that amount first.
      if (entryFee > 0n) {
        const approveHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [poolsAddress, entryFee],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const joinHash = await walletClient.writeContract({
        address: poolsAddress,
        abi: healthPoolsAbi,
        functionName: "joinPool",
        args: [poolId, nullifier],
      });
      await publicClient.waitForTransactionReceipt({ hash: joinHash });

      setStatus({ kind: "joined", txHash: joinHash });
      await queryClient.invalidateQueries({ queryKey: ["pool"] });
      await queryClient.invalidateQueries({ queryKey: ["participants"] });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Verification request failed.",
      });
    }
  };

  if (status.kind === "joined") {
    return (
      <div className="rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
        <p className="text-base font-semibold text-accent">
          You are in. One verified human, one entry.
        </p>
        {status.txHash !== null ? (
          <a
            href={arcTxUrl(status.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-sm text-accent underline"
          >
            View join transaction on Arcscan
          </a>
        ) : null}
      </div>
    );
  }

  const busy =
    status.kind === "preparing" ||
    status.kind === "awaiting-proof" ||
    status.kind === "verifying" ||
    status.kind === "joining";

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => {
          if (!authenticated) {
            login();
            return;
          }
          void startJoin();
        }}
        className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status.kind === "preparing"
          ? "Preparing verification..."
          : status.kind === "awaiting-proof"
            ? "Waiting for World ID..."
            : status.kind === "verifying"
              ? "Verifying proof..."
              : status.kind === "joining"
                ? "Joining on-chain..."
                : authenticated
                  ? "Join with World ID"
                  : "Sign in to join"}
      </button>
      <p className="text-xs text-muted">
        Joining requires a one-time World ID proof of humanity. Your health
        data never goes on-chain, only verified outcomes do.
      </p>
      {status.kind === "error" ? (
        <ErrorNote
          title="Could not join the pool"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
      {rpContext !== null ? (
        <IDKitRequestWidget
          open={widgetOpen}
          onOpenChange={(open) => {
            setWidgetOpen(open);
            if (!open && status.kind === "awaiting-proof") {
              setStatus({ kind: "idle" });
            }
          }}
          app_id={WORLD_APP_ID}
          action={`${WORLD_ACTION_ID}-${poolId}`}
          rp_context={rpContext}
          allow_legacy_proofs={true}
          preset={proofOfHuman(
            address !== null ? { signal: address } : undefined,
          )}
          onSuccess={(result) => {
            void submitProof(result);
          }}
          onError={(code) => {
            setWidgetOpen(false);
            setStatus({
              kind: "error",
              message: `World ID verification did not complete (${code}).`,
            });
          }}
        />
      ) : null}
    </div>
  );
}

export default function JoinPool({
  poolId,
  entryFee,
  alreadyJoined = false,
}: {
  poolId: bigint;
  entryFee: bigint;
  alreadyJoined?: boolean;
}) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable joining with an embedded wallet."
      />
    );
  }
  return (
    <JoinPoolInner
      poolId={poolId}
      entryFee={entryFee}
      alreadyJoined={alreadyJoined}
    />
  );
}
