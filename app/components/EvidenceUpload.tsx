"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { displayGoalSpec } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { ErrorNote } from "@/components/ui";

// text/plain is included so the demo sample records in public/demo-evidence/
// (.txt) can be uploaded directly.
const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
] as const;
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB keeps the base64 POST venue-WiFi friendly.

// Poll cadence for /api/evidence/result. The attester is fast (often one ~3s
// poll), but we cap the attempts so a stuck job surfaces an error instead of
// spinning forever. 20 tries * 2.5s ≈ 50s ceiling.
const POLL_INTERVAL_MS = 2_500;
const MAX_POLLS = 20;

type Confidence = "low" | "medium" | "high";

interface SubmitResponse {
  attesterId?: string;
  error?: string;
}

interface ResultResponse {
  status?: "verifying" | "completed" | "failed";
  verified?: boolean;
  confidence?: Confidence;
  reason?: string;
  recorded?: boolean;
  txHash?: string;
  error?: string;
}

// Lab-result style timeline steps. `active` is the current in-flight step.
type TimelineStep =
  | "uploaded"
  | "verifying"
  | "verdict"
  | "settling"
  | "paid";

const TIMELINE_ORDER: TimelineStep[] = [
  "uploaded",
  "verifying",
  "verdict",
  "settling",
  "paid",
];

const TIMELINE_LABELS: Record<TimelineStep, string> = {
  uploaded: "Uploaded",
  verifying: "Verifying privately in a secure enclave (TEE)",
  verdict: "Verdict received",
  settling: "Settling on Arc",
  paid: "Paid",
};

type UploadStatus =
  | { kind: "idle" }
  | { kind: "progress"; step: TimelineStep }
  | {
      kind: "result";
      verified: boolean;
      confidence: Confidence;
      reason: string;
      recorded: boolean;
      txHash: string | null;
      error: string | null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pick a content type the API accepts, defaulting plain/empty types to text/plain. */
function normalizeContentType(file: File): string {
  if (
    (ACCEPTED_TYPES as readonly string[]).includes(file.type) &&
    file.type !== ""
  ) {
    return file.type;
  }
  // Browsers sometimes report .txt as "" — treat as plain text.
  if (file.name.toLowerCase().endsWith(".txt")) return "text/plain";
  return file.type;
}

function StatusTimeline({ active }: { active: TimelineStep }) {
  const activeIndex = TIMELINE_ORDER.indexOf(active);
  return (
    <ol className="space-y-2">
      {TIMELINE_ORDER.map((step, index) => {
        const done = index < activeIndex;
        const current = index === activeIndex;
        return (
          <li key={step} className="flex items-center gap-3">
            <span
              className={
                done
                  ? "flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-background"
                  : current
                    ? "h-5 w-5 animate-pulse rounded-full border-2 border-accent bg-accent-deep"
                    : "h-5 w-5 rounded-full border-2 border-edge"
              }
              aria-hidden
            >
              {done ? "✓" : ""}
            </span>
            <span
              className={
                done || current
                  ? "text-sm font-medium text-foreground"
                  : "text-sm text-muted"
              }
            >
              {TIMELINE_LABELS[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
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
    const contentType = normalizeContentType(file);
    if (!(ACCEPTED_TYPES as readonly string[]).includes(contentType)) {
      setSelected(null);
      setFormError("Upload a PNG, JPG, PDF, or TXT record.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSelected(null);
      setFormError("File is too large. Use a file under 8 MB.");
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setSelected({ name: file.name, contentType, base64 });
    } catch (err) {
      setSelected(null);
      setFormError(
        err instanceof Error ? err.message : "Could not read the file.",
      );
    }
  };

  const submit = async () => {
    if (selected === null || address === null) return;

    // Step 1 — submit the document to the attester and get a job id.
    setStatus({ kind: "progress", step: "uploaded" });
    let attesterId: string;
    try {
      const res = await fetch("/api/evidence/submit", {
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
          "Document verification is not live yet. The /api/evidence/submit route is still being deployed.",
        );
      }

      const body = (await res.json().catch(() => ({}))) as SubmitResponse;
      if (!res.ok || typeof body.attesterId !== "string") {
        throw new Error(
          body.error ?? `Verification service responded ${res.status}.`,
        );
      }
      attesterId = body.attesterId;
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Could not submit the record.",
      });
      return;
    }

    // Step 2 — poll for the verdict.
    setStatus({ kind: "progress", step: "verifying" });
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_INTERVAL_MS);

      let body: ResultResponse;
      try {
        const res = await fetch("/api/evidence/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attesterId,
            poolId: poolId.toString(),
            address,
            goalSpec,
          }),
        });
        body = (await res.json().catch(() => ({}))) as ResultResponse;
        if (!res.ok) {
          throw new Error(
            body.error ?? `Verification service responded ${res.status}.`,
          );
        }
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Verification request failed.",
        });
        return;
      }

      if (body.status === "verifying") {
        // keep the verifying step visible; loop again.
        continue;
      }

      // completed or failed — settle the UI.
      const verified = body.verified === true;
      const recorded = body.recorded === true;

      if (verified && recorded) {
        // Briefly show the "settling / paid" steps for the clinical feel.
        setStatus({ kind: "progress", step: "settling" });
        await sleep(600);
        setStatus({ kind: "progress", step: "paid" });
        await sleep(400);
      } else if (verified) {
        // verified but not recorded (e.g. join-first) — surface the verdict step.
        setStatus({ kind: "progress", step: "verdict" });
        await sleep(300);
      }

      setStatus({
        kind: "result",
        verified,
        confidence: body.confidence ?? "low",
        reason:
          body.reason ??
          (verified
            ? "Document accepted."
            : "Document could not be verified."),
        recorded,
        txHash: typeof body.txHash === "string" ? body.txHash : null,
        error: typeof body.error === "string" ? body.error : null,
      });

      if (verified) {
        await queryClient.invalidateQueries({ queryKey: ["pool"] });
        await queryClient.invalidateQueries({ queryKey: ["participant"] });
      }
      return;
    }

    // Exhausted polls without a terminal status.
    setStatus({
      kind: "error",
      message:
        "Verification is taking longer than expected. The secure enclave did not return a verdict in time — please try again.",
    });
  };

  const resetUpload = () => {
    setSelected(null);
    setStatus({ kind: "idle" });
    setFormError(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const busy = status.kind === "progress";

  // In-flight: show the lab-result style status timeline.
  if (status.kind === "progress") {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Verifying your record</h3>
        <p className="text-sm text-muted">
          Your document is being checked privately inside a confidential AI
          enclave (TEE). Nothing leaves the enclave; only the verdict is recorded
          on-chain.
        </p>
        <div className="rounded-xl border border-accent/30 bg-accent-deep/10 p-4">
          <StatusTimeline active={status.step} />
        </div>
      </div>
    );
  }

  // Verified + recorded result: green payout card.
  if (status.kind === "result" && status.verified && status.recorded) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
          <p className="text-base font-semibold text-accent">
            Record verified. Your bounty is on its way.
          </p>
          <p className="mt-1 text-sm text-foreground/80">{status.reason}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-muted">
            {CONFIDENCE_LABELS[status.confidence]} · Verified privately in a TEE
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

  // Verified but not recorded (e.g. has not joined the pool yet).
  if (status.kind === "result" && status.verified && !status.recorded) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-base font-semibold text-warning">
            Document verified, but not yet recorded
          </p>
          <p className="mt-1 text-sm text-foreground/80">
            {status.error ??
              "Join the pool first, then re-submit your evidence to claim the bounty."}
          </p>
          <p className="mt-2 text-xs uppercase tracking-wide text-muted">
            {CONFIDENCE_LABELS[status.confidence]} · Verified privately in a TEE
          </p>
        </div>
        <button
          type="button"
          onClick={resetUpload}
          className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Submit your record</h3>
      <p className="text-sm text-muted">
        Upload proof for {readableGoal === "" ? "this goal" : `"${readableGoal}"`}.
        It is checked privately inside a confidential AI enclave (TEE) and the
        bounty pays out the moment it verifies. Accepts PNG, JPG, PDF, or TXT.
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
          : "Tap to choose a file (PNG, JPG, PDF, or TXT)"}
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
          {authenticated
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
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable submitting records with an embedded wallet."
      />
    );
  }
  return <EvidenceUploadInner poolId={poolId} goalSpec={goalSpec} />;
}
