# CRE local simulation — blocker (captured 2026-06-13)

## Command run (from `cre/`, env loaded from `../.env`)

```bash
set -a; source ../.env; set +a
cre workflow simulate ./wf-goal-verification \
  --non-interactive --trigger-index 0 \
  --http-payload ./simulation/callback-payload.json --broadcast
```

Also tried: `--target local-simulation`, `--target staging-settings`, with and
without `--broadcast`, with `-e ../.env`, and with `--verbose`. All produce the
same result.

## Exact blocker message

```
Initializing...

! You are not logged in

✗ Authentication required: not logged in and no CRE_API_KEY set
  → Run 'cre login' interactively, or
  → Set CRE_API_KEY environment variable for non-interactive use
✗ authentication required: no credentials found: you are not logged in, run cre login and try again
```

(full capture in `cre-simulate-broadcast.log`)

## Diagnosis

- Installed CRE CLI is **v1.20.0**. The official Chainlink Confidential AI
  Attester demo was verified with **v1.19.0**, where local `--http-payload`
  simulation needed no login.
- In v1.20.0 the auth check fires at **"Initializing..."**, BEFORE workflow
  compilation or the simulator runs — so this is a CLI gate, not a code or
  payload problem. The verbose log shows nothing reaches compilation.
- There is no `CRE_API_KEY` in `../.env` and no cached credentials under
  `~/.cre/` (only `bin/` and `update.json`).

## What this does NOT block (verified offline)

The workflow's deterministic core was validated without the CRE host via
`bun run dry-run` (output: `dry-run.json`). It parses the recorded Attester
callback, derives the verdict + digest, computes `goalId`, and ABI-encodes the
exact `HealthVerdict.onReport` report body. That encoded body is then pinned
on-chain by the Foundry test `test_onReport_decodesWorkflowEncodedReport`, which
decodes the identical hex through `onReport` and asserts the verdict — proving
the off-chain encoding ↔ on-chain decode contract is correct end to end.

## To unblock the live `cre workflow simulate`

One of:
1. Run `cre login` once interactively (opens a browser auth flow), then re-run
   the simulate command in the same shell. v1.20.0 caches the token under
   `~/.cre/`; subsequent `--non-interactive` runs work.
2. Set `CRE_API_KEY` (from the Chainlink CRE console / booth) in `../.env`, then
   `set -a; source ../.env; set +a` and re-run.
3. Downgrade the CLI to v1.19.0 (`cre update` / pin the version), which matches
   the demo's no-login local-simulation behavior.
