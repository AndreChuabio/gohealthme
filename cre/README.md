# GoHealthMe — Chainlink CRE workflow (Confidential AI Attester)

`wf-goal-verification` is a single Chainlink CRE workflow that verifies whether a
GoHealthMe participant met a health goal, **confidentially** (the analysis runs
inside a TEE), and writes a DON-signed verdict on chain.

It follows Chainlink's **official Confidential AI Attester callback architecture**,
reimplemented for the health-goal domain. Reference (MIT, (c) Chainlink Labs),
studied and adapted with attribution (see `../AI_ATTRIBUTION.md`):

> Chainlink Confidential AI Attester — Undercollateralized Loan Demo
> https://github.com/smartcontractkit/chainlink-confidential-ai-attester-demo

No reference source files were copied verbatim. Our contracts, workflow, report
encoding, and synthetic (no-PHI) documents are GoHealthMe's own.

## Architecture (callback model)

This is NOT an outbound `ConfidentialHTTPClient` call. The app POSTs a health
document to the Attester with a `cre_callback` URL; the Attester runs inference in
its TEE and POSTs the verdict back to that URL — which IS this workflow's
HTTP-trigger endpoint.

```
  GoHealthMe app / cre/scripts/call-attester.mjs
      |  POST /v1/inference  (synthetic health summary + cre_callback = CRE trigger URL)
      v
  Chainlink Confidential AI Attester   (LLM inside a TEE)
      |  decides verified/declined, signs request+response digests,
      |  POSTs the verdict to cre_callback
      v
  CRE workflow  (wf-goal-verification/main.ts)
      1. HTTP trigger receives the callback body (payload.input bytes)
      2. status !== "completed"  -> log + return early
      3. parse the verdict JSON from `output` (strip the ```json fence)
            -> { verified, confidence, reason, metric_value, threshold }
      4. digest = resources[0].response_digest        (TEE transcript hash)
      5. goalId = keccak256(abi.encode(poolId, user)) [matches HealthVerdict.computeGoalId]
      6. encodeAbiParameters(bytes32 goalId, bool verified, uint8 confidence,
                             bytes32 digest, uint16 bitmap)
      7. runtime.report(...)  ->  EVMClient.writeReport(...)
      |  signed report, delivered via the KeystoneForwarder
      v
  contracts/src/HealthVerdict.sol :: onReport(bytes metadata, bytes report)  [onlyForwarder]
      • abi.decode(report) -> (goalId, verified, confidence, digest, bitmap)
      • records the verdict (same storage as recordVerdict)
      v
  HealthPools.settle() consults HealthVerdict.canSettle(goalId)
```

### The on-chain interface (exact match with the workflow)

`HealthVerdict.onReport` is the Chainlink CRE / KeystoneForwarder receiver:

```solidity
function onReport(bytes calldata metadata, bytes calldata report) external onlyForwarder {
    (bytes32 goalId, bool verified, uint8 confidence, bytes32 digest, uint16 bitmap) =
        abi.decode(report, (bytes32, bool, uint8, bytes32, uint16));
    // ... one-shot record into the same storage as recordVerdict ...
}
```

The workflow encodes the report body with the identical tuple order/types:

```ts
const REPORT_ABI = [
  { name: 'goalId',     type: 'bytes32' },
  { name: 'verified',   type: 'bool'    },
  { name: 'confidence', type: 'uint8'   },
  { name: 'digest',     type: 'bytes32' },
  { name: 'bitmap',     type: 'uint16'  },
] as const
const encodedReport = encodeAbiParameters(REPORT_ABI, [goalId, verified, confU8, digest, bitmap])
```

This off-chain → on-chain contract is pinned by the Foundry test
`test_onReport_decodesWorkflowEncodedReport`, which feeds the *exact* hex the
workflow's dry-run produces back through `onReport` and asserts the decoded
verdict. `computeGoalId` matches `HealthVerdict.computeGoalId`
(`keccak256(abi.encode(poolId, participant))`).

### Two ingestion paths (both into the same storage)

1. `recordVerdict(...)` — the **attester-EOA path** (a relayer that holds the
   `attester` role). Kept for backward compatibility and non-CRE flows.
2. `onReport(metadata, report)` — the **Chainlink CRE / KeystoneForwarder path**
   (`onlyForwarder`). The forwarder defaults to `address(0)` (disabled) until the
   owner calls `setForwarder(...)` with the real Forwarder on the target chain (or
   a mock forwarder in tests).

## Privacy design

1. **The raw health doc is analysed inside the Attester's TEE.** The DON never
   sees raw wearable samples; the app sends the doc to the Attester, not to the
   workflow.
2. **The workflow only ever sees the structured verdict + signed digests** in the
   callback body.
3. **Nothing sensitive lands on chain.** `HealthVerdict` stores only
   `{ verified, confidence, keccak(transcript digest), facet bitmap, attester, timestamp }`.

## Project layout

```
cre/
  project.yaml                          # CRE project settings (targets, rpcs)
  package.json / tsconfig.json          # TS toolchain (typecheck + dry-run + call-attester)
  wf-goal-verification/
    workflow.yaml                       # workflow settings (no secrets-path: callback model)
    main.ts                             # the workflow (Attester callback -> onReport via forwarder)
    config.json                         # poolId, user, receiver, chain selector, authorizedKeys
    package.json                        # workflow deps for the cre/bun compile step
  scripts/call-attester.mjs             # app-side: POST a health doc to the Attester w/ cre_callback
  simulation/
    callback-payload.json               # recorded Attester callback (offline simulation input)
    health-summary.txt                  # synthetic, no-PHI weekly health summary
    inference-prompt.txt                # the exact /v1/inference prompt
  src/dry-run.ts                        # deterministic offline harness (no CRE host needed)
  sim-output/                           # captured outputs + BLOCKER.md
```

## How to simulate

### Prerequisites

```bash
~/.cre/bin/cre version     # v1.20.0 here
~/.bun/bin/bun --version   # 1.3.x here
cd cre && bun install
```

### Scenario 1 — offline simulation (recorded callback)

Run from `cre/`, with env loaded from the repo `.env`:

```bash
set -a; source ../.env; set +a
cre workflow simulate ./wf-goal-verification \
  --non-interactive --trigger-index 0 \
  --http-payload ./simulation/callback-payload.json \
  --broadcast
```

> **Known blocker on this machine:** CRE CLI **v1.20.0** requires a Chainlink
> login *before* it will simulate (even offline with `--http-payload`). The
> official demo was verified on v1.19.0 where local simulation needed no login.
> Exact message and full diagnosis: `sim-output/BLOCKER.md` and
> `sim-output/cre-simulate-broadcast.log`. To unblock: run `cre login` once
> (browser flow) **or** set `CRE_API_KEY` in `../.env`, then re-run; **or**
> downgrade the CLI to v1.19.0.

### Scenario 2 — live end-to-end (Attester -> local trigger)

Needs ngrok (or cloudflared) to expose the local trigger to the remote Attester.

```bash
# terminal 1 — start the workflow's local HTTP-trigger server (no --http-payload)
set -a; source ../.env; set +a
cre workflow simulate ./wf-goal-verification --broadcast
#   -> "listening on http://localhost:2000/trigger"

# terminal 2 — expose port 2000
ngrok http 2000            # -> https://<id>.ngrok-free.dev

# terminal 3 — POST a synthetic health doc to the Attester with that callback URL
set -a; source ../.env; set +a
node scripts/call-attester.mjs "https://<id>.ngrok-free.dev/trigger"
```

The Attester runs inference in its TEE and POSTs the verdict to the ngrok tunnel
-> the local trigger -> the workflow encodes it and (with `--broadcast` + a real
receiver) writes through `HealthVerdict.onReport`.

### Deterministic dry-run (no CRE host, no auth, no network)

```bash
cd cre
bun run dry-run            # uses simulation/callback-payload.json
#   captured: sim-output/dry-run.json
```

This reproduces the workflow's deterministic core (parse callback, derive verdict
+ digest, compute goalId, ABI-encode the `onReport` report body) with viem only.

## What works now vs. what needs the booth

### Verified locally

- Workflow typechecks clean against `@chainlink/cre-sdk@1.11.0`.
- Dry-run produces the correct goalId, verdict, digest, bitmap, and the exact
  `onReport` report body.
- The encoded report body decodes correctly on chain — pinned by
  `test_onReport_decodesWorkflowEncodedReport` (Foundry). Full contract suite: 62
  tests passing (51 pre-existing + 11 new for the forwarder / onReport path).

### Blocked / needs credentials

- **`cre workflow simulate` requires authentication on CLI v1.20.0.** See
  `sim-output/BLOCKER.md`.

### Needs the Chainlink booth for a LIVE DON write

1. **KeystoneForwarder address on Arc.** `EVMClient.writeReport` forwards the
   DON-signed report through the KeystoneForwarder, which calls `onReport`.
   `HealthVerdict.setForwarder(<arc-forwarder>)` must point at it (use the
   mock-forwarder address when writing with `--broadcast`, the production
   Forwarder for a real DON). Confirm the Arc forwarder address at the booth.
2. **Chain selector / chain-name for Arc.** `project.yaml` uses
   `chain-name: arc-testnet`; `config.json` uses `chainSelector: "5042002"`.
   Confirm the chain-name registered in Chainlink's chain-selectors registry and
   the matching selector the DON expects (use `--allow-unknown-chains` if Arc is
   experimental).
3. **Receiver wiring.** Deploy `HealthVerdict`, call `setForwarder(...)`, and set
   `config.healthVerdictAddress` to the deployment. Until then leave it as the
   zero address: the workflow produces the signed report and skips `writeReport`,
   so simulation still completes.

## Config reference (`wf-goal-verification/config.json`)

| key | meaning |
|---|---|
| `poolId` | pool the goal belongs to; part of the deterministic goalId |
| `user` | participant address; part of the deterministic goalId |
| `healthVerdictAddress` | receiver; zero address = report-only (not yet deployed) |
| `chainSelector` | receiver chain selector (Arc) |
| `writeGasLimit` | gas limit for the `writeReport` forward |
| `authorizedKeys` | ECDSA keys allowed to sign incoming HTTP trigger requests (empty = accept any, for simulation) |
