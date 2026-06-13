# GoHealthMe

Verified health goals with instant USDC rewards. Built at ETHGlobal New York 2026.

Insurers already pay people for healthy behaviors — through opaque points systems and gift cards that arrive weeks later. GoHealthMe puts that model on-chain: sponsor-funded USDC pools pay out the instant a verified behavior happens, gated so every participant is a unique human, with goals and achievements living on ENS as portable health reputation.

## How it works

1. Anyone funds an initiative pool (sleep, workouts, preventive care) with USDC and published bounties
2. Participants join with a World ID proof — one human, one entry; the product breaks without proof-of-human
3. Wearable data (WHOOP) verifies the behavior off-chain; only verdicts ever touch the chain
4. The pool settles instantly: achievers get paid, forfeits roll back into the pool
5. Optional: stake on your own streak for a multiplier, or back someone else's goal

## Architecture

```
Next.js (frontend + API) -- Privy embedded wallets
   |          |
   |          +-- World ID cloud verify (backend)
   |          +-- WHOOP OAuth -> oracle signer
   |                               |
   |                               v
   |                    HealthPools.sol (Arc testnet)
   |                    USDC escrow / settle / multipliers
   |                               |
   +-- ENS on Sepolia <------------+
       pools = subnames, terms in text records
       user subnames carry achievement records
```

Chains: Arc testnet (chain id 5042002, USDC-native) for the product, Ethereum Sepolia for the ENS registry, Base Sepolia for cross-chain pool funding via Circle Gateway (stretch).

Privacy invariant: raw health data never touches the chain — only verdicts, streaks, and badges.

## Repo layout

- `contracts/` — Foundry: HealthPools.sol, tests, deploy scripts
- `app/` — Next.js App Router: frontend and API routes
- `scripts/` — pool seeding and demo helpers

## Team

Andre Chuabio, Nikki Hu
