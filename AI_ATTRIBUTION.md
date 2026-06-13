# AI Attribution

This project uses AI-assisted development (Claude Code). Per ETHGlobal rules, AI-assisted files are listed here and kept current throughout the event.

All entries below were produced during the event (after Fri Jun 12, 9:00pm EDT) with human review by the team (Andre Chuabio, Nikki Hu).

| File / area | Nature of AI assistance |
|---|---|
| Repo scaffold (.gitignore, .env.example, README.md) | AI-generated, human-reviewed |
| contracts/src/HealthPools.sol | AI-assisted Solidity with human-defined interface (frozen in build plan) and review |
| contracts/test/HealthPools.t.sol | AI-generated Foundry tests and MockUSDC, human-reviewed |
| contracts/script/Deploy.s.sol, contracts/foundry.toml | AI-generated deploy script and config, human-reviewed |
| app/ | AI-assisted Next.js scaffold and components, human-reviewed |
| app/lib/useUsdcDeposit.ts | AI-generated reusable approve+write deposit hook (Blink swap point), human-reviewed |
| app/components/CreatePool.tsx, app/app/pools/create/page.tsx | AI-generated pool creation flow, human-reviewed |
| app/components/FundPool.tsx | AI-generated pool top-up component, human-reviewed |
| app/components/BackGoal.tsx | AI-assisted refactor onto shared deposit hook, human-reviewed |
| cre/wf-goal-verification/main.ts | AI-generated Chainlink CRE workflow, callback architecture (HTTP-trigger Attester callback → verdict parse → onReport via KeystoneForwarder), reimplemented for health goals from the official MIT-licensed Chainlink reference (see below), human-reviewed |
| cre/wf-goal-verification/workflow.yaml, cre/project.yaml, cre/wf-goal-verification/config.json | AI-generated CRE project manifests matching the official confidential-ai-attester / minimal-cre-examples schema, human-reviewed |
| cre/scripts/call-attester.mjs | AI-generated app-side helper that POSTs a synthetic health doc to the Confidential AI Attester with a cre_callback URL, adapted from the demo's curl block, human-reviewed |
| cre/simulation/callback-payload.json, cre/simulation/health-summary.txt, cre/simulation/inference-prompt.txt | AI-generated recorded Attester callback, synthetic (no-PHI) health summary, and inference prompt, human-reviewed |
| cre/src/dry-run.ts | AI-generated deterministic offline dry-run for the callback core (no DON / no network), human-reviewed |
| contracts/src/HealthVerdict.sol (onReport, forwarder, IReceiver) | AI-assisted KeystoneForwarder receiver path added to the existing registry, modeled on the reference LoanGate.onReport, human-reviewed |
| contracts/test/HealthVerdict.t.sol (onReport / forwarder tests, MockKeystoneForwarder) | AI-generated Foundry tests for the CRE ingestion path, human-reviewed |
| cre/README.md | AI-generated CRE workflow docs (callback architecture, privacy design, simulation steps, booth dependencies), human-reviewed |

Design decisions, architecture, and prize strategy: human-led with AI research support (documented in team notes).

## Third-party reference (MIT)

The Chainlink CRE integration (callback architecture, `onReport` / KeystoneForwarder
receiver pattern, simulation payload shape, and `cre workflow simulate --broadcast`
invocation) was adapted from Chainlink's official, MIT-licensed demo:

- **Chainlink Confidential AI Attester — Undercollateralized Loan Demo**
  https://github.com/smartcontractkit/chainlink-confidential-ai-attester-demo
  (MIT License, (c) Chainlink Labs)

It was studied and **reimplemented for GoHealthMe's health-goal domain** — our own
contracts (`HealthVerdict`), workflow (`wf-goal-verification`), report encoding, and
synthetic no-PHI health documents. No reference source files were copied verbatim
into this repo.
