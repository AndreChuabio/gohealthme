# GoHealthMe — Handoff

Onboarding doc for anyone (human or AI agent) picking up this build. Read this top to bottom first.
Built at ETHGlobal New York 2026 by Andre Chuabio + Nikki Hu.

## What it is

Sponsor-funded USDC reward pools for verified health goals. A sponsor (insurer, employer, brand)
funds a pool with published bounties ("sleep score >= 75 for 3 nights = $X"); a participant joins
(one human, one entry, via World ID), their wearable/health data is verified, and USDC settles
instantly to achievers. Optional layers: stake on your own streak for a multiplier, or back someone
else's goal. The pitch: the UnitedHealthcare rewards model, but instant, transparent, and sybil-proof.

Why crypto: programmable escrow that pays the instant a verified behavior happens, a rewards pool no
one can sybil-farm (World ID), and portable health reputation. Insurers already pay for this through
opaque points and slow gift cards; we make it trustless and instant.

## Submitted partner picks (the 3-pick cap)

Arc + World + Chainlink. (ENS was dropped — Sepolia ENS is mid-migration to v2 and registration was
unreliable; see "Open items".) Other sponsors may be integrated for the demo but only these 3 are
submitted. The submit decision is final at the Sunday form.

## Repo layout

- `contracts/` — Foundry. `src/HealthPools.sol` (pools, joinPool w/ World ID nullifier, recordResult,
  settle, backGoal, multipliers) and `src/HealthVerdict.sol` (Chainlink verdict registry + onReport
  receiver). Tests in `test/`. `scripts/Deploy.s.sol`.
- `app/` — Next.js App Router (TypeScript, Tailwind). Frontend + API routes. THIS is the Next project
  root — env loads from `app/.env.local`, NOT the repo-root `.env` (see "Env").
- `cre/` — Chainlink CRE goal-verification workflow (Confidential AI Attester callback pattern).
- `scripts/` — `demo-reset.sh` (clean-slate redeploy+seed), `happy-path-test.sh` (live end-to-end proof).
- `DEPLOYMENTS.md` — canonical on-chain addresses. `AI_ATTRIBUTION.md` — required AI-assist log.

## Live on-chain (Arc testnet, chain id 5042002, USDC is the gas token)

- HealthPools (canonical): `0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064` — has 3 seeded pools.
- Oracle signer: `0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D` (funded ~0.5 USDC).
- Deployer / contract owner: `0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1` (~1.3 USDC left — top up at
  https://faucet.circle.com before heavy work).
- HealthVerdict: built + tested but NOT yet deployed (deploy Saturday alongside the Chainlink booth).
- Arc RPC: https://rpc.testnet.arc.network | Explorer: https://testnet.arcscan.app | USDC ERC-20:
  0x3600000000000000000000000000000000000000 (6 decimals).

## How to run

- Frontend: `cd app && npm install && npm run dev` -> http://localhost:3000. Needs `app/.env.local`
  (see Env). Pages: `/`, `/pools`, `/pools/[id]`, `/pools/create`, `/dashboard`.
- Contracts: `cd contracts && forge test` (62 tests, all green). foundry at ~/.foundry/bin.
- Demo reset (fresh deploy + seed 3 pools + sync env): `./scripts/demo-reset.sh` from repo root.
- Happy-path proof (live on Arc, ~90s): `./scripts/happy-path-test.sh`.
- CRE dry-run (offline, no auth): `cd cre && bun run dry-run`. Live sim needs Chainlink CLI auth (see Open items).

## Env (IMPORTANT gotcha)

The Next app reads env from `app/.env.local` (its project root is `app/`), NOT the repo-root `.env`.
The repo-root `.env` is used by the shell scripts (deploy, happy-path, demo-reset). When you add a
secret, put app-needed vars in `app/.env.local`. Both files are gitignored. NEXT_PUBLIC_* vars must be
in `app/.env.local` to reach the browser (e.g. the World ID widget needs NEXT_PUBLIC_WORLD_APP_ID /
NEXT_PUBLIC_WORLD_ACTION_ID, which are aliases of the server WORLD_APP_ID / WORLD_ACTION_ID).

Currently set: Privy (NEXT_PUBLIC_PRIVY_APP_ID, PRIVY_APP_SECRET), World ID (WORLD_APP_ID,
WORLD_ACTION_ID + NEXT_PUBLIC aliases), Arc/oracle (ORACLE_SIGNER_PRIVATE_KEY, HEALTH_POOLS_ADDRESS,
ARC_RPC_URL, ORACLE_API_SECRET), Chainlink attester (CONFIDENTIAL_AI_API_KEY), CRE (CRE_ETH_PRIVATE_KEY,
CRE_TARGET=staging-settings). MISSING: WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET (Nikki's).

## Architecture (data flow)

Next.js (frontend + API routes) with Privy embedded wallets ->
- World ID proof verified in `app/api/world/verify` -> nullifier stored per-pool in `joinPool` (one
  human, one entry; product is sybil-farmed without it = World Track B).
- WHOOP OAuth (`app/api/whoop/*`) -> derived health summary -> verdict.
- Verdict path A (today's demo): `app/lib/server/oracle.ts` server signs `recordResult` to HealthPools.
- Verdict path B (Chainlink): `cre/` workflow receives a Confidential AI Attester callback (TEE
  inference over the health doc) -> DON-signed report -> `HealthVerdict.onReport` -> HealthPools.settle()
  gates on `HealthVerdict.canSettle(goalId)` when the gate is enabled.
- Settlement on Arc in USDC. Privacy invariant: raw health data never goes on-chain — only verdicts.

## Open items / next steps

1. WHOOP creds (Nikki): add WHOOP_CLIENT_ID + WHOOP_CLIENT_SECRET to `app/.env.local` -> the full live
   happy path (real wearable data -> oracle -> settle) works end to end.
2. Chainlink CLI auth: `cre workflow simulate` (v1.20) needs `cre login` or a CRE_API_KEY. Login email
   codes were not arriving; resolve via Andrej/Chainlink booth (he hands out keys) OR try CLI v1.19.0
   (`curl -sSL https://cre.chain.link/install.sh | bash -s -- v1.19.0`) which did not enforce login.
   Then `cd cre && npm run simulate`. CLI simulation = the qualifying Chainlink prize artifact.
3. Deploy HealthVerdict to Arc + (optional) flip the gate: deploy it (forge create, not forge script —
   see gotcha), `pools.setHealthVerdict(addr)` to enable Chainlink-gated mode. Leave gate OFF
   (address(0)) to keep the proven oracle-only demo working.
4. Booth (for a LIVE on-chain DON write): get the real KeystoneForwarder address on Arc, call
   `HealthVerdict.setForwarder(addr)`, confirm Arc chain selector.
5. Submission: finalize `notes/Submission Draft.md` (in the eth/ workspace, not this repo), record demo
   video, complete the 3 partner feedback forms.

## Rules (do not violate — these can cost the prize)

- From-scratch: only code written after Fri 9:00pm EDT. Commit continuously (sponsors audit git history).
- EASEeHealth (Darbease/EASEeHealth) is a PRE-EVENT, UNLICENSED repo — REFERENCE ONLY, never copy.
- The Chainlink Confidential AI Attester demo (smartcontractkit/chainlink-confidential-ai-attester-demo)
  is MIT + official — safe to reference/adapt WITH attribution (done in AI_ATTRIBUTION.md). Reimplement.
- Keep `AI_ATTRIBUTION.md` current. Never commit secrets (.env / app/.env.local are gitignored).

## Gotchas learned (save yourself the pain)

- Arc's native USDC delegatecalls a blocklist precompile that forge's script simulation can't execute,
  so `forge script` reverts on anything moving USDC. Use `forge create` + `cast send` instead (that's
  why demo-reset.sh and happy-path-test.sh use cast). View calls and `forge test` (with MockUSDC) are fine.
- Next env location (above) — the #1 "why isn't my key working" cause.
- Sepolia ENS is mid-migration to v2; public docs + ens-contracts point at an unauthorized controller;
  the live registration UI app.ens.dev is v2 and warns names may be reset. That's why ENS was dropped.

## Demo spine (no MediaPipe — shelved as gimmicky)

Real WHOOP sleep streak -> oracle/attester verdict -> USDC lands live on Arc (the WOW) -> audience backs
a goal via World ID QR. Settlement is the punchline. Keep one clean happy path; everything else is gravy.
