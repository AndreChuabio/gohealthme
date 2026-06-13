#!/usr/bin/env bash
#
# Full document-evidence chain proof (on-chain):
#   create doc pool -> join -> upload cholesterol doc -> attester verdict ->
#   recordResult on-chain -> settle -> USDC lands with the achiever.
#
# Proves the multimodal/preventive-care path end to end. Uses a short-period
# throwaway pool so settle runs in ~90s. Needs the dev server on :3000 (for the
# attester evidence routes) and a funded deployer. Run from repo root.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
POOLS="$HEALTH_POOLS_ADDRESS"
KEY="$DEPLOYER_PRIVATE_KEY"
ME="$(cast wallet address --private-key "$KEY")"
GOAL="[doc] Upload a lab report showing total cholesterol under 200 mg/dL"
FUND=1000000   # 1 USDC pot
PERIOD=90

echo "== doc-evidence chain test on $POOLS (participant $ME) =="

NOW="$(date +%s)"; END=$((NOW + PERIOD))
echo "-> approve + create short-period doc pool (model 1 split-pot)"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$FUND" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
cast send "$POOLS" "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
  "cholesterol-test" "$GOAL" 0 "$NOW" "$END" 1 "$FUND" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
PID="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"; PID="${PID%% *}"
echo "   poolId = $PID"

echo "-> join pool $PID (synthetic nullifier; World gate is verified separately)"
cast send "$POOLS" "joinPool(uint256,uint256)" "$PID" "$NOW" --private-key "$KEY" --rpc-url "$RPC" >/dev/null

echo "-> submit cholesterol doc to the attester via /api/evidence/submit"
B64="$(base64 -i app/public/demo-evidence/cholesterol-panel.txt | tr -d '\n')"
SUB="$(curl -s -m 30 -X POST localhost:3000/api/evidence/submit -H 'Content-Type: application/json' \
  -d "{\"poolId\":\"$PID\",\"address\":\"$ME\",\"goalSpec\":\"$GOAL\",\"fileBase64\":\"$B64\",\"fileName\":\"cholesterol-panel.txt\",\"contentType\":\"text/plain\"}")"
AID="$(echo "$SUB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("attesterId",""))')"
echo "   attesterId = $AID"

echo "-> poll /api/evidence/result until the verdict records on-chain"
TXH=""
for i in $(seq 1 15); do
  sleep 4
  R="$(curl -s -m 20 -X POST localhost:3000/api/evidence/result -H 'Content-Type: application/json' \
    -d "{\"attesterId\":\"$AID\",\"poolId\":\"$PID\",\"address\":\"$ME\",\"goalSpec\":\"$GOAL\"}")"
  ST="$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
  echo "   poll $i: $(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status="+str(d.get("status"))+" verified="+str(d.get("verified"))+" recorded="+str(d.get("recorded"))+" tx="+str(d.get("txHash","")))' 2>/dev/null)"
  if [ "$ST" = "completed" ]; then TXH="$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("txHash") or "")')"; break; fi
done

echo "-> waiting out the period, then settle"
sleep $((PERIOD + 10))
BEFORE="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$ME" --rpc-url "$RPC")"; BEFORE="${BEFORE%% *}"
cast send "$POOLS" "settle(uint256)" "$PID" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
AFTER="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$ME" --rpc-url "$RPC")"; AFTER="${AFTER%% *}"

echo ""
echo "record txHash: ${TXH:-<none>}"
echo "USDC before settle $BEFORE -> after $AFTER (gain $((AFTER - BEFORE)) uUSDC)"
if [ -n "$TXH" ] && [ "$AFTER" -gt "$BEFORE" ]; then
  echo "PASS: full document-evidence chain proven on-chain (create -> join -> doc -> attester verdict -> record -> settle -> paid)"
else
  echo "CHECK: verdict tx=${TXH:-none}; settle gain=$((AFTER-BEFORE)). Inspect above."
fi
