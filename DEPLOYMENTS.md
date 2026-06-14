HealthPools (Arc testnet, chain 5042002)

## CURRENT (canonical)
- Address: 0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Explorer: https://testnet.arcscan.app/address/0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Oracle signer: 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D
- Seeded via scripts/demo-reset.sh: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym)
- Re-seed / clean slate: run ./scripts/demo-reset.sh (deploys fresh, syncs env, this file)

## Superseded
- 0x4527e4b2ee489282fb01fe890487149f9f1aaa46 (first deploy; had the now-shelved pushups pool)
- 0xEA46F189860AC7d07801ed25E4ABD246a3a31A02 (empty, deploy-path debug)

## Demo reset 2026-06-13T02:42:17Z
- HealthPools: 0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Explorer: https://testnet.arcscan.app/address/0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym)

## HealthVerdict registry (Tier 1 — Chainlink verdict gate) 2026-06-13
- HealthVerdict: 0x4E65F11b65b53A328713B40C02A1BC1F421E1c51
- Explorer: https://testnet.arcscan.app/address/0x4E65F11b65b53A328713B40C02A1BC1F421E1c51
- Owner: 0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1 (deployer) | Attester: 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D (oracle) | Forwarder: unset (onReport/DON path is Tier 2)
- canSettle(goalId) gates HealthPools._isAchiever when HealthPools.setHealthVerdict points here.
- NOTE: the canonical prod HealthPools (0x72D3...2064) predates the gate selectors, so it cannot consult the registry. Wiring it requires a redeploy.

## Gated HealthPools (Tier 1 gate proof instance) 2026-06-13
- HealthPools (gated): 0x5bf7CD46d1f6D8AE8889ea63C65AF54DFCB22cF4 — setHealthVerdict -> 0x4E65...1c51
- Proof: scripts/tier1-gate-proof.sh — two identical participants, only the verdict-backed one paid (2 USDC vs 0).
- Settle tx: 0x3e26d9a0e9fb71339323b7bb0754e0bca614ff392ae8cfca72bf17605c8c8c53
- Separate from prod on purpose (prod demo untouched).
