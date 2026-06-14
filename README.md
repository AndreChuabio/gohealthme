# GoHealthMe

Verified health goals with instant USDC rewards. Built at ETHGlobal New York 2026.

Insurers already pay people for healthy behaviors — through opaque points systems and gift cards that arrive weeks later. GoHealthMe puts that model on-chain: sponsor-funded USDC pools pay out the instant a verified behavior happens, gated so every participant is a unique human, with the verification done by a confidential, decentralized oracle rather than a company.

Partners: Arc (USDC settlement chain), World (proof-of-human), Chainlink (CRE + Confidential AI Attester verification).

## How it works

1. Anyone funds an initiative pool (sleep, workouts, preventive care) with USDC and published bounties
2. Participants join with a World ID proof — one human, one entry; the product breaks without proof-of-human
3. Health data is verified off-chain (WHOOP, or a Chainlink Confidential AI Attester judging the goal inside a TEE); only the verdict ever touches the chain
4. The pool settles instantly: achievers get paid, forfeits roll back into the pool
5. Optional: stake on your own streak for a multiplier, or back someone else's goal

## Architecture

```
Next.js (frontend + API) -- Privy embedded wallets
   |          |
   |          +-- World ID cloud verify (backend) --> nullifier gates joinPool
   |          +-- WHOOP OAuth -> health summary
   |                               |
   |              verdict path A (live demo): oracle signer
   |              verdict path B (Chainlink):
   |                Confidential AI Attester (TEE inference)
   |                  -> CRE workflow callback
   |                  -> DON-signed report
   |                  -> HealthVerdict.onReport
   |                               |
   |                               v
   |                    HealthPools.sol (Arc testnet)
   |                    USDC escrow / settle / multipliers / backing
   |                    settle() gates on HealthVerdict.canSettle() when enabled
```

Chains: Arc testnet (chain id 5042002, USDC-native) for the product and settlement. Chainlink CRE runs the off-chain goal-verification workflow. (ENS was evaluated as an identity/registry layer but dropped — Sepolia ENS was mid-migration to v2 during the event.)

Privacy invariant: raw health data never touches the chain — the Confidential AI Attester judges it inside a TEE and only the signed verdict (verified / confidence / digest) is recorded on-chain.

## Arbiter reliability (eval harness)

The attester is the oracle that gates real USDC, so we measure how trustworthy its verdicts are and harden it with **multi-judge consensus**. `app/eval/` runs synthetic lab reports (no real PHI) through the attester and scores each arbiter config; the headline metric is the **false-positive rate** — a wrongful "verified" is a wrongful payout.

The enclave exposes two models (`gemma4`, `qwen3.6`); the panel varies `{model} × {prompt} × {sample}` and a **K-of-N quorum** aggregates them, **failing closed** on disagreement.

Result (17 synthetic cases, live verdicts): a single `qwen3.6` wrongly approved 2 borderline cases (15% false-positive rate); a single strict `gemma4` over-rejected valid reports; the **2-of-2 quorum had 0% false positives and caught both wrongful approvals**. No single model is a safe money oracle — requiring agreement is.

```
cd app
npm run eval:demo   # instant replay of a recorded run (no enclave calls)
npm run eval        # live run against the attester (slow — shared enclave queue)
npm test            # unit tests (consensus, panel, scorer)
```

## Repo layout

- `contracts/` — Foundry: `HealthPools.sol` (pools, World ID nullifier gating, settle, backing, multipliers) and `HealthVerdict.sol` (Chainlink verdict registry + `onReport` receiver); tests; deploy script
- `app/` — Next.js App Router: frontend and API routes (World verify, WHOOP, oracle signer). `app/lib/server/` holds the attester client + consensus; `app/eval/` is the arbiter reliability harness.
- `cre/` — Chainlink CRE goal-verification workflow (Confidential AI Attester callback pattern)
- `scripts/` — `demo-reset.sh` (clean redeploy + seed) and `happy-path-test.sh` (live end-to-end proof)

See `HANDOFF.md` for run steps, on-chain addresses, env setup, and open items.

## Team

Andre Chuabio, Nikki Hu
