"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { PRIVY_CONFIGURED } from "@/lib/config";
import { displayGoalSpec } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { ErrorNote } from "@/components/ui";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB keeps the base64 POST venue-WiFi friendly.

type Confidence = "low" | "medium" | "high";

interface VerifyResponse {
  verified?: boolean;
  confidence?: Confidence;
  reason?: string;
  txHash?: string;
  error?: string;
}

type UploadStatus =
  | { kind: "idle" }
  | { kind: "verifying" }
  | {
      kind: "result";
      verified: boolean;
      confidence: Confidence;
      reason: string;
      txHash: string | null;
    }
  | { kind: "error"; message: string };

interface SelectedFile {
  name: string;
  contentType: string;
  base64: string;
}

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

/** Read a File into a bare base64 string (no data: prefix) in the browser. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file reader output."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function EvidenceUploadInner({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  const readableGoal = displayGoalSpec(goalSpec);

  const onPickFile = async (file: File | null) => {
    setFormError(null);
    setStatus({ kind: "idle" });
    if (file === null) {
      setSelected(null);
      return;
    }
    if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
      setSelected(null);
      setFormError("Upload a PNG, JPG, or PDF record.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSelected(null);
      setFormError("File is too large. Use a file under 8 MB.");
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setSelected({ name: file.name, contentType: file.type, base64 });
    } catch (err) {
      setSelected(null);
      setFormError(
        err instanceof Error ? err.message : "Could not read the file.",
      );
    }
  };

  const submit = async () => {
    if (selected === null || address === null) return;
    setStatus({ kind: "verifying" });
    try {
      const res = await fetch("/api/evidence/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolId: poolId.toString(),
          address,
          goalSpec,
          fileBase64: selected.base64,
          fileName: selected.name,
          contentType: selected.contentType,
        }),
      });

      if (res.status === 404) {
        throw new Error(
          "Document verification is not live yet. The /api/evidence/verify route is still being deployed.",
        );
      }

      const body = (await res.json().catch(() => ({}))) as VerifyResponse;

      if (!res.ok) {
        throw new Error(
          body.error ?? `Verification service responded ${res.status}.`,
        );
      }

      setStatus({
        kind: "result",
        verified: body.verified === true,
        confidence: body.confidence ?? "low",
        reason:
          body.reason ??
          (body.verified === true
            ? "Document accepted."
            : "Document could not be verified."),
        txHash: typeof body.txHash === "string" ? body.txHash : null,
      });

      if (body.verified === true) {
        await queryClient.invalidateQueries({ queryKey: ["pool"] });
        await queryClient.invalidateQueries({ queryKey: ["participant"] });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Verification request failed.",
      });
    }
  };

  const resetUpload = () => {
    setSelected(null);
    setStatus({ kind: "idle" });
    setFormError(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const busy = status.kind === "verifying";

  if (status.kind === "result" && status.verified) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
          <p className="text-base font-semibold text-accent">
            Record verified. Your bounty is on its way.
          </p>
          <p className="mt-1 text-sm text-foreground/80">{status.reason}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-muted">
            {CONFIDENCE_LABELS[status.confidence]}
          </p>
          {status.txHash !== null ? (
            <a
              href={arcTxUrl(status.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block break-all text-sm text-accent underline"
            >
              View payout transaction on Arcscan
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Submit your record</h3>
      <p className="text-sm text-muted">
        Upload proof for {readableGoal === "" ? "this goal" : `"${readableGoal}"`}.
        We check it against the goal and pay the bounty the moment it verifies.
        Accepts PNG, JPG, or PDF.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        disabled={busy}
        onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />

      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center rounded-xl border border-dashed border-accent/40 bg-accent-deep/10 px-5 py-6 text-center text-sm font-medium text-accent hover:bg-accent-deep/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {selected !== null
          ? `Selected: ${selected.name}`
          : "Tap to choose a file (PNG, JPG, or PDF)"}
      </button>

      {selected !== null && status.kind !== "result" ? (
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
          className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy
            ? "Verifying..."
            : authenticated
              ? "Verify record and claim bounty"
              : "Sign in to submit"}
        </button>
      ) : null}

      {formError !== null ? (
        <ErrorNote
          title="Check the file"
          detail={formError}
          onRetry={() => setFormError(null)}
        />
      ) : null}

      {status.kind === "result" && !status.verified ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
            <p className="text-base font-semibold text-warning">
              We could not verify this record
            </p>
            <p className="mt-1 text-sm text-foreground/80">{status.reason}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-muted">
              {CONFIDENCE_LABELS[status.confidence]}
            </p>
          </div>
          <button
            type="button"
            onClick={resetUpload}
            className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
          >
            Upload a different file
          </button>
        </div>
      ) : null}

      {status.kind === "error" ? (
        <ErrorNote
          title="Could not verify the record"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
    </div>
  );
}

export default function EvidenceUpload({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  if (!PRIVY_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_PRIVY_APP_ID to enable submitting records with an embedded wallet."
      />
    );
  }
  return <EvidenceUploadInner poolId={poolId} goalSpec={goalSpec} />;
}
