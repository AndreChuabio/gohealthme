/**
 * Standalone dry-run for wf-goal-verification.
 *
 * The real `cre workflow simulate` runs the workflow inside the CRE WASM host,
 * which supplies the trigger, the confidential-http capability, and the DON
 * report signer. This harness reproduces the DETERMINISTIC core of the workflow
 * (goalId, mock judge tiering, digest, facet bitmap, and the exact ABI-encoded
 * recordVerdict call) using only viem, so the pipeline can be verified in plain
 * Node before the CRE CLI / DON are wired up.
 *
 * What it canNOT do (needs the CRE host): produce a real DON-signed Report or
 * perform the on-chain writeReport. Those are covered by `cre workflow simulate`
 * and, for a live write, the Chainlink booth (see README).
 *
 * Run: npx tsx src/dry-run.ts [path/to/payload.json]
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'

type Confidence = 'low' | 'medium' | 'high'
const CONFIDENCE_TO_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
const FACET_WEARABLE = 1 << 0
const FACET_AI_ATTESTED = 1 << 2

const RECORD_VERDICT_ABI = [
  {
    type: 'function',
    name: 'recordVerdict',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'goalId', type: 'bytes32' },
      { name: 'verified', type: 'bool' },
      { name: 'confidence', type: 'uint8' },
      { name: 'digest', type: 'bytes32' },
      { name: 'bitmap', type: 'uint16' },
    ],
    outputs: [],
  },
] as const

interface GoalVerificationInput {
  poolId: number
  user: Address
  goalSpec: string
  baselineWeekAvg: number
  currentWindowAvg: number
  streakDays: number
}

interface JudgeVerdict {
  verified: boolean
  confidence: Confidence
  multiplierBps: number
}

const computeGoalId = (poolId: number, user: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { name: 'poolId', type: 'uint256' },
        { name: 'participant', type: 'address' },
      ],
      [BigInt(poolId), user],
    ),
  )

const mockJudge = (input: GoalVerificationInput): JudgeVerdict => {
  const improved = input.currentWindowAvg > input.baselineWeekAvg
  const gain = input.baselineWeekAvg > 0
    ? (input.currentWindowAvg - input.baselineWeekAvg) / input.baselineWeekAvg
    : 0
  if (improved && input.streakDays >= 5) {
    return { verified: true, confidence: 'high', multiplierBps: 12_000 + Math.round(gain * 5_000) }
  }
  if (improved || input.streakDays >= 3) {
    return { verified: true, confidence: 'medium', multiplierBps: 10_500 }
  }
  return { verified: false, confidence: 'low', multiplierBps: 0 }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const payloadPath = process.argv[2] ?? resolve(__dirname, '../payloads/goal-verification.json')
const input = JSON.parse(readFileSync(payloadPath, 'utf8')) as GoalVerificationInput

const goalId = computeGoalId(input.poolId, input.user)
const verdict = mockJudge(input)
const digest = keccak256(
  stringToHex(
    JSON.stringify({
      verified: verdict.verified,
      confidence: verdict.confidence,
      multiplierBps: verdict.multiplierBps,
    }),
  ),
)
const bitmap = FACET_AI_ATTESTED | FACET_WEARABLE
const encodedCall = encodeFunctionData({
  abi: RECORD_VERDICT_ABI,
  functionName: 'recordVerdict',
  args: [goalId, verdict.verified, CONFIDENCE_TO_U8[verdict.confidence], digest, bitmap],
})

const out = {
  workflow: 'wf-goal-verification',
  mode: 'dry-run (deterministic core, no DON signature / no on-chain write)',
  input,
  goalId,
  verdict,
  confidenceU8: CONFIDENCE_TO_U8[verdict.confidence],
  digest,
  bitmap,
  bitmapBits: { wearable: Boolean(bitmap & FACET_WEARABLE), aiAttested: Boolean(bitmap & FACET_AI_ATTESTED) },
  receiverCall: 'HealthVerdict.recordVerdict(bytes32,bool,uint8,bytes32,uint16)',
  encodedCall,
  note: 'In the CRE host this encodedCall is wrapped by runtime.report(...) into a DON-signed report, then EVMClient.writeReport forwards it to HealthVerdict on Arc.',
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(out, null, 2))
