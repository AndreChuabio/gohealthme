# GoHealthMe — Chainlink CRE workflow

`wf-goal-verification` is a single Chainlink CRE (Chainlink Runtime Environment)
workflow that judges whether a GoHealthMe user met a health goal, off-chain and
confidentially, then writes a DON-signed verdict on chain.

It targets the **base CRE prize via CLI simulation**: no live deployment is
required for the base track. This directory is a self-contained CRE project built
from scratch against the public Chainlink CRE docs (docs.chain.link/cre) and the
official `@chainlink/cre-sdk` type definitions (v1.11.0).

## What the workflow does

```
HTTP trigger (signed POST)                          [trigger]
  payload = derived health summaries (NO raw wearable data)
        |
        v
  computeGoalId(poolId, user) = keccak256(abi.encode(poolId, user))   [matches HealthVerdict.computeGoalId]
        |
        v
  judge the goal:
    - simulation: deterministic mock judge (inline OR local HTTP stub)
    - production: ConfidentialHTTPClient -> LLM/scoring endpoint
                  (summaries encrypted to the enclave; DON operators never see them)
    -> { verified, confidence: low|medium|high, multiplierBps }
        |
        v
  digest  = keccak256(judge response)        [never the inputs]
  bitmap  = FACET_AI_ATTESTED (bit2) | FACET_WEARABLE (bit0) = 0x5
        |
        v
  encodeFunctionData(HealthVerdict.recordVerdict(goalId, verified, confidence, digest, bitmap))
        |
        v
  runtime.report(...)            -> DON-signed report over the encoded call   [step 1]
        |
        v
  EVMClient.writeReport(...)      -> DON forwards the report to HealthVerdict  [step 2]
```

Receiver: `HealthVerdict.recordVerdict(bytes32 goalId, bool verified, uint8 confidence, bytes32 digest, uint16 bitmap)`
(see `../contracts/src/HealthVerdict.sol`). The 4-byte selector `0xaf35f456` and the
`computeGoalId` encoding are both verified against that contract.

## Privacy design

This is the reason CRE is the right tool here, not a plain server:

1. **Only derived summaries leave the app.** The HTTP payload is
   `{ poolId, user, goalSpec, baselineWeekAvg, currentWindowAvg, streakDays }` —
   week averages and a streak count, never raw wearable samples.
2. **The confidential HTTP call hides the summaries from DON operators.** In
   production the scoring call goes through `ConfidentialHTTPClient`; the request
   body and the `Authorization` secret (`{{.judgeApiKey}}`, sourced from the
   Vault DON) are encrypted to the scoring enclave. Individual DON node operators
   running the workflow never observe the user's health data.
3. **Nothing sensitive lands on chain.** `HealthVerdict` stores only
   `{ verified, confidence, keccak(judge response), facet bitmap, attester, timestamp }`.
   The inputs and the raw judge response are never written on chain. This mirrors
   the invariant stated in `HealthVerdict.sol`.

## Project layout

```
cre/
  project.yaml                     # CRE project settings (targets, rpcs) — canonical schema
  package.json / tsconfig.json     # TS toolchain (typecheck + dry-run)
  wf-goal-verification/
    workflow.yaml                  # workflow settings (user-workflow, workflow-artifacts)
    main.ts                        # the workflow (HTTP trigger -> confidential judge -> DON write)
    config.json                    # owner, judge URL/secret, receiver, chain selector, authorizedKeys
    package.json                   # workflow deps for the cre/bun compile step
  config note: useMockJudge=true keeps simulation credential-free
  mock-judge/server.mjs            # local HTTP stub judge (deterministic; for the confidential path)
  payloads/goal-verification.json  # sample HTTP trigger payload
  src/dry-run.ts                   # standalone deterministic harness (no CRE host needed)
  sim-output/                      # captured outputs
```

### Mock judge: which is which

- **Inline mock** (`mockJudge` in `main.ts`, used when `config.useMockJudge=true`):
  a pure function of the summaries. No network, no credentials. This is what the
  CLI simulation exercises by default.
- **HTTP stub** (`mock-judge/server.mjs`): the same scoring rule exposed as a
  real `POST /judge` endpoint on `localhost:8787`. Set `config.useMockJudge=false`
  and `config.judgeUrl=http://localhost:8787/judge` to exercise the actual
  `ConfidentialHTTPClient` code path locally.
- **Production judge**: any LLM/scoring endpoint returning
  `{ verified, confidence, multiplierBps }`; the API key is a Vault DON secret.

Scoring rule (identical in all three): improvement vs baseline AND streak >= 5
days -> `high`; improvement OR streak >= 3 -> `medium`; otherwise `low`/not verified.

## How to simulate

### Prerequisites

```bash
# CRE CLI (installs to ~/.cre/bin and adds it to PATH)
curl -sSL https://app.chain.link/cre/install.sh | bash
cre version            # expect v1.20.0+

# Bun is required to compile TypeScript workflows to WASM
curl -fsSL https://bun.sh/install | bash
bun --version          # expect 1.0.0+
```

### Run the simulation

```bash
cd cre
npm install            # or: bun install
cre login              # opens a browser; OR: export CRE_API_KEY=<key from app.chain.link>

cre workflow simulate ./wf-goal-verification \
  --target local-simulation \
  --non-interactive --trigger-index 0 \
  --http-payload @./payloads/goal-verification.json
```

The simulator compiles `main.ts` to WASM (via Bun), feeds the payload to the HTTP
trigger, runs the callback, and reports the DON-signed report and the encoded
`recordVerdict` call. With `useMockJudge=true` it needs no external credentials.

### Deterministic dry-run (no CRE host, no auth)

The CRE CLI requires a Chainlink account login even to simulate (see Blockers).
`src/dry-run.ts` reproduces the deterministic core of the workflow — goalId, mock
judge tiering, digest, facet bitmap, and the exact ABI-encoded `recordVerdict`
call — using only viem, so the pipeline is verifiable in plain Node:

```bash
cd cre
npx tsx src/dry-run.ts                  # uses payloads/goal-verification.json
# captured output: sim-output/dry-run.json
```

## What works in simulation vs what needs the Chainlink booth (Saturday)

### Verified locally (works now)

- Workflow typechecks clean against `@chainlink/cre-sdk@1.11.0` (`npm run typecheck`).
- Workflow bundles cleanly with Bun (`bun build ./wf-goal-verification/main.ts`):
  482 modules, all SDK + viem imports resolve — the code the CLI would compile is sound.
- Deterministic dry-run produces the correct goalId, verdict, digest, bitmap, and
  the exact `recordVerdict` calldata. `recordVerdict` selector `0xaf35f456` and
  `computeGoalId` encoding both match `HealthVerdict.sol`.
- Mock judge (inline and HTTP stub) returns identical, reproducible verdicts.
- CRE CLI v1.20.0 and Bun 1.3.x installed and working.

### Blocked / needs credentials

- **`cre workflow simulate` requires authentication.** CLI v1.20.0 refuses to
  simulate (or even `cre init`) without `cre login` (interactive browser) or
  `CRE_API_KEY` from app.chain.link. The exact error is captured in
  `sim-output/cre-simulate-final.log`:

  ```
  ✗ Authentication required: not logged in and no CRE_API_KEY set
  ```

  Resolution: run `cre login` with a Chainlink account, then re-run the command
  above. Everything else is in place.

### Needs the Chainlink booth for a LIVE DON write

A live on-chain write (vs. the simulated report) needs information the public docs
did not fully specify (the live receiver/forwarder interface page 404'd):

1. **Forwarder address on Arc.** `EVMClient.writeReport` forwards the DON-signed
   report through a CRE Forwarder contract on the target chain; `HealthVerdict`
   must trust that Forwarder as its `attester` (or sit behind a receiver that
   verifies the report). Confirm the Forwarder address the DON uses on Arc.
   `cre workflow supported-chains` lists the mock forwarder addresses per tenant —
   confirm Arc is registered.
2. **Chain selector / chain-name for Arc.** `project.yaml` currently uses
   `chain-name: arc-testnet`; `config.json` uses `chainSelector: "5042002"`
   (Arc chain id). Confirm the chain-name registered in Chainlink's
   chain-selectors registry and the matching CCIP-style selector the DON expects
   (may differ from the raw chain id; use `--allow-unknown-chains` if Arc is
   experimental).
3. **Attester wiring.** `HealthVerdict` is deployed with a single `attester`
   address. For live DON writes set `attester` to the Forwarder (or the DON
   write address) via `setAttester(...)`. Until then, leave
   `config.healthVerdictAddress` as the zero address: the workflow then produces
   the signed report and skips `writeReport`, so simulation still completes.
4. **Vault DON secret provisioning.** For the production confidential judge,
   provision `judgeApiKey` (and, if encrypting responses,
   `san_marino_aes_gcm_encryption_key`) in the Vault DON owned by
   `config.owner`. Not needed for the mock simulation.

## Config reference (`wf-goal-verification/config.json`)

| key | meaning |
|---|---|
| `owner` | Vault DON secret owner + config owner |
| `judgeUrl` | scoring endpoint (mock stub in sim, LLM in prod) |
| `judgeSecretName` | Vault DON secret name, referenced in the request as `{{.name}}` |
| `useMockJudge` | `true` = inline deterministic judge (credential-free sim); `false` = confidential HTTP call |
| `healthVerdictAddress` | receiver; zero address = report-only (HealthVerdict not yet deployed) |
| `chainSelector` | receiver chain selector (Arc) |
| `writeGasLimit` | gas limit for the `writeReport` forward |
| `authorizedKeys` | ECDSA public keys allowed to sign incoming HTTP trigger requests |
