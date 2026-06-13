#!/usr/bin/env bash
#
# Demo seed/reset for GoHealthMe.
#
# Default: deploys a FRESH HealthPools on Arc testnet, seeds three branded pools,
# then syncs the new address into .env, app/.env.local, and DEPLOYMENTS.md so the
# whole app points at the clean contract. Run before a demo run.
#
# Uses forge create + cast send (NOT forge script): Arc's native USDC delegatecalls
# a blocklist precompile that forge's local simulation can't execute, so script-based
# seeding reverts at simulation. cast/forge-create broadcast directly and work fine.
#
# Usage (from repo root):
#   ./scripts/demo-reset.sh                         # fresh deploy + seed (clean slate)
#   EXISTING_POOLS=0x.. ./scripts/demo-reset.sh     # seed into the current contract
#   SEED_FUNDING=2000000 ./scripts/demo-reset.sh    # 2 USDC per pool (default 1 USDC)
#
# Requires: foundry on PATH, funded DEPLOYER_PRIVATE_KEY + ORACLE_SIGNER_PRIVATE_KEY
# in .env. Gas on Arc is native USDC: top up at https://faucet.circle.com.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"

[ -f .env ] || { echo "error: .env not found at repo root" >&2; exit 1; }
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
FUND="${SEED_FUNDING:-1000000}"          # 1 USDC per pool (6 decimals)
KEY="$DEPLOYER_PRIVATE_KEY"
DEPLOYER="$(cast wallet address --private-key "$KEY")"
ORACLE="${ORACLE:-$(cast wallet address --private-key "$ORACLE_SIGNER_PRIVATE_KEY")}"

# Budget check: gas (native USDC) + 3 fundings must fit.
TOTAL_FUND=$((FUND * 3))
BAL="$(cast call "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC")"
BAL="${BAL%% *}"
if [ "$BAL" -lt "$TOTAL_FUND" ]; then
  echo "error: deployer USDC ($BAL) < seed funding ($TOTAL_FUND). Top up: https://faucet.circle.com" >&2
  exit 1
fi

# 1. Deploy fresh, or reuse an existing contract.
if [ -n "${EXISTING_POOLS:-}" ]; then
  POOLS="$EXISTING_POOLS"
  echo "==> Seeding into existing HealthPools $POOLS"
else
  echo "==> Deploying fresh HealthPools (oracle $ORACLE)"
  # Run from contracts/; --constructor-args MUST be last (the flag is greedy and will
  # otherwise swallow trailing flags as extra constructor args).
  POOLS="$( ( cd contracts && forge create src/HealthPools.sol:HealthPools \
    --rpc-url "$RPC" --private-key "$KEY" --broadcast \
    --constructor-args "$USDC" "$ORACLE" ) | awk '/Deployed to:/ {print $3}')"
  [ -n "$POOLS" ] || { echo "error: deploy failed (no address)" >&2; exit 1; }
  echo "    deployed at $POOLS"
fi

# 2. Approve USDC for the three fundings.
echo "==> Approving $TOTAL_FUND USDC"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$TOTAL_FUND" \
  --private-key "$KEY" --rpc-url "$RPC" >/dev/null

# 3. Seed three branded, wearable-verifiable pools (no MediaPipe — matches the demo spine).
NOW="$(date +%s)"
seed_pool() {
  local initiative="$1" goal="$2" entry="$3" days="$4" model="$5"
  local end=$((NOW + days * 86400))
  cast send "$POOLS" \
    "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
    "$initiative" "$goal" "$entry" "$NOW" "$end" "$model" "$FUND" \
    --private-key "$KEY" --rpc-url "$RPC" >/dev/null
  echo "    seeded: $initiative"
}

echo "==> Seeding pools"
seed_pool "sleep"    "Sleep performance score 75 or higher for 3 consecutive nights (sponsored by Dreamwell Mattress)" 250000 3 0
seed_pool "recovery" "WHOOP recovery 60 percent or higher on 5 of 7 days (sponsored by Vitality Insurance)"          250000 7 1
seed_pool "steps"    "10,000 steps daily for 5 days (sponsored by Iron Gym)"                                         0      5 0

# 4. Sync the address into env files.
echo "==> Syncing address into .env, app/.env.local, DEPLOYMENTS.md"
python3 - "$POOLS" <<'PY'
import re, sys
addr = sys.argv[1]
def set_kv(path, key, value):
    try: s = open(path).read()
    except FileNotFoundError: s = ""
    if re.search(rf"^{re.escape(key)}=.*$", s, flags=re.M):
        s = re.sub(rf"^{re.escape(key)}=.*$", f"{key}={value}", s, flags=re.M)
    else:
        s = (s.rstrip("\n") + "\n" if s else "") + f"{key}={value}\n"
    open(path, "w").write(s)
set_kv(".env", "HEALTH_POOLS_ADDRESS", addr)
set_kv("app/.env.local", "NEXT_PUBLIC_HEALTH_POOLS_ADDRESS", addr)
PY

{
  echo ""
  echo "## Demo reset $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- HealthPools: $POOLS"
  echo "- Explorer: https://testnet.arcscan.app/address/$POOLS"
  echo "- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym)"
} >> DEPLOYMENTS.md

POOL_COUNT="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"
echo ""
echo "===================================================================="
echo " Demo reset complete"
echo "   HealthPools : $POOLS"
echo "   poolCount   : ${POOL_COUNT%% *}"
echo "   Explorer    : https://testnet.arcscan.app/address/$POOLS"
echo "   Updated     : .env, app/.env.local, DEPLOYMENTS.md"
echo "   Restart the dev server so it reads the new address."
echo "===================================================================="
