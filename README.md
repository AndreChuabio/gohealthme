# GoHealthMe

Verified health goals with instant USDC rewards. Built at ETHGlobal New York 2026.

Insurers already pay people for healthy behaviors — through opaque points systems and gift cards that arrive weeks later. GoHealthMe puts that model on-chain: sponsor-funded USDC pools pay out the instant a verified behavior happens, gated so every participant is a unique human, with the verification done by a confidential, decentralized oracle rather than a company.

Partners: Arc (USDC settlement chain), World (proof-of-human), Chainlink (CRE + Confidential AI Attester verification).

## How it works

1. Anyone funds an initiative pool (sleep, workouts, preventive care) with USDC and published bounties
2. Participants join with a World ID proof — one human, one entry; the product breaks without proof-of-human
3. Health data is verified off-chain (wearables via Junction — WHOOP/Oura/Fitbit/Garmin — or a Chainlink Confidential AI Attester judging the goal inside a TEE); only the verdict ever touches the chain
4. The pool settles instantly: achievers get paid (optionally to a private Unlink account derived from their own wallet signature, with no on-chain link to the goal), forfeits roll back into the pool
5. Optional: stake on your own streak for a multiplier, back someone else's goal, or top up USDC in one tap via Blink

## Architecture

```
Next.js (frontend + API) -- Dynamic embedded wallets + Unlink private payouts
   |          |
   |          +-- World ID cloud verify (backend) --> nullifier gates joinPool
   |          +-- Junction Link (WHOOP/Oura/Fitbit/Garmin) -> health summary
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

## Local development

### Prerequisites

- **Node.js 22.x** — required by the app; [install from nodejs.org](https://nodejs.org)
- **npm** (included with Node.js) or **yarn** — package manager

### Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/your-repo/gohealthme.git
   cd gohealthme
   npm install
   ```

2. **Environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Then open `.env.local` and fill in the placeholders. See the variable reference below for details on what each integration requires.

3. **Start the dev server**
   ```bash
   cd app
   npm run dev
   ```
   The app will be available at `http://localhost:3000`.

### Environment variables

Copy `.env.example` to `.env.local` and fill in the values. Variables marked **required to boot** are needed for the app to start; others enable specific integrations. **All key material in `.env.local` must be placeholder values only — never commit real secrets.**

**Chains & Contracts**
| Variable | Description | Required |
|----------|-------------|----------|
| `ARC_RPC_URL` | RPC endpoint for Arc testnet | Boot |
| `ARC_CHAIN_ID` | Chain ID for Arc testnet (5042002) | Boot |
| `SEPOLIA_RPC_URL` | Sepolia RPC endpoint for optional flows | Integration |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC endpoint for Blink | Blink integration |
| `ARC_USDC_ADDRESS` | USDC token address on Arc testnet | Boot |
| `HEALTH_POOLS_ADDRESS` | Deployed HealthPools contract address | Boot |

**Server Keys** ⚠️ (Server-only; never commit real values to `.env.example`)
| Variable | Description | Required |
|----------|-------------|----------|
| `ORACLE_SIGNER_PRIVATE_KEY` | Signer key for oracle verdicts | Boot |
| `DEPLOYER_PRIVATE_KEY` | Key for contract deployments | Deploy only |
| `TREASURY_PRIVATE_KEY` | Key for treasury (USDC sponsor account) | Boot |

**World ID** (Proof-of-human verification)
| Variable | Description | Required |
|----------|-------------|----------|
| `WORLD_APP_ID` | World ID app credential from developer portal | World ID integration |
| `WORLD_ACTION_ID` | World ID action ID (defaults to `join-pool`) | World ID integration |
| `WORLD_RP_ID` | World ID 4.0 relying-party context | World ID integration |
| `WORLD_SIGNER_PRIVATE_KEY` | Key for signing World ID rp_context | World ID integration |

**Junction / Vital** (Health data from wearables)
| Variable | Description | Required |
|----------|-------------|----------|
| `JUNCTION_API_KEY` | API key from Junction/Vital dashboard | Junction integration |
| `JUNCTION_BASE_URL` | Junction endpoint; use sandbox for demos | Junction integration |
| `JUNCTION_REGION` | Region code (e.g., `us`) | Junction integration |
| `JUNCTION_ENV` | Environment (e.g., `sandbox`) | Junction integration |

**Dynamic** (Wallet/authentication)
| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | Dynamic environment ID from dashboard | Boot |

**Unlink** (Private payouts; server-only)
| Variable | Description | Required |
|----------|-------------|----------|
| `UNLINK_ENGINE_URL` | Unlink TEE engine URL | Unlink integration |
| `UNLINK_API_KEY` | Unlink API key | Unlink integration |
| `UNLINK_ENVIRONMENT` | Environment (e.g., `arc-testnet`) | Unlink integration |
| `UNLINK_TREASURY_PRIVATE_KEY` | Key for Unlink treasury account | Unlink integration |
| `UNLINK_TREASURY_MNEMONIC` | BIP-39 mnemonic for shielded account | Unlink integration |

**Confidential AI Attester** (Chainlink TEE goal verification)
| Variable | Description | Required |
|----------|-------------|----------|
| `CONFIDENTIAL_AI_API_KEY` | API key for Confidential AI Attester | Chainlink integration |
| `DEMO_MODE` | When `true`, mock attester if real one unavailable | Demo only |

**Blink** (One-tap USDC top-up on Base Sepolia; server-only)
| Variable | Description | Required |
|----------|-------------|----------|
| `BLINK_MERCHANT_PRIVATE_KEY` | ECDSA P-256 key (PKCS8 PEM) | Blink integration |
| `BLINK_MERCHANT_ID` | Merchant ID from Blink dashboard | Blink integration |
| `BLINK_MERCHANT_ADDRESS` | Base Sepolia receive address | Blink integration |

**NEXT_PUBLIC_* Aliases** (Inlined into browser; must be in `app/.env.local`)
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_HEALTH_POOLS_ADDRESS` | = `HEALTH_POOLS_ADDRESS` |
| `NEXT_PUBLIC_WORLD_APP_ID` | = `WORLD_APP_ID` |
| `NEXT_PUBLIC_WORLD_ACTION_ID` | = `WORLD_ACTION_ID` |
| `NEXT_PUBLIC_UNLINK_APP_ID` | Unlink project ID from dashboard (browser-safe) |
| `NEXT_PUBLIC_BLINK_USDC_ADDRESS` | Base Sepolia USDC token address |
| `NEXT_PUBLIC_BLINK_MERCHANT_ADDRESS` | = `BLINK_MERCHANT_ADDRESS` |
| `NEXT_PUBLIC_BLINK_SIGNER_ENDPOINT` | Optional; defaults to `/api/blink/sign` |

### Common commands

- **Dev server:** `cd app && npm run dev` (http://localhost:3000)
- **Build:** `cd app && npm run build`
- **Tests:** `cd app && npm run test` or `npm run test:watch`
- **Lint:** `cd app && npm run lint`
- **Full reset (contracts + data):** `bash scripts/demo-reset.sh` (see `scripts/demo-reset.sh`)
- **End-to-end test:** `bash scripts/happy-path-test.sh` (see `scripts/happy-path-test.sh`)

## Repo layout

- `contracts/` — Foundry: `HealthPools.sol` (pools, World ID nullifier gating, settle, backing, multipliers) and `HealthVerdict.sol` (Chainlink verdict registry + `onReport` receiver); tests; deploy script
- `app/` — Next.js App Router: frontend and API routes (World verify, WHOOP, oracle signer)
- `cre/` — Chainlink CRE goal-verification workflow (Confidential AI Attester callback pattern)
- `scripts/` — `demo-reset.sh` (clean redeploy + seed) and `happy-path-test.sh` (live end-to-end proof)

See `HANDOFF.md` for run steps, on-chain addresses, env setup, and open items.

## Team

Andre Chuabio, Nikki Hu
