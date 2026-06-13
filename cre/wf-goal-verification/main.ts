/**
 * wf-goal-verification — GoHealthMe Chainlink CRE workflow.
 *
 * Trigger:  HTTP (signed POST to the CRE gateway).
 * Purpose:  judge whether a user met a health goal, off-chain and confidentially,
 *           then write a DON-signed verdict to HealthVerdict.recordVerdict on Arc.
 *
 * Privacy invariant
 * -----------------
 * The HTTP payload carries ONLY DERIVED SUMMARIES (week averages, a streak count,
 * a goal spec) — never raw wearable samples. The scoring call is made through the
 * confidential-http capability, so even those summaries are encrypted to the
 * judge endpoint and are not visible to individual DON node operators. On chain we
 * store only { verified, confidence, keccak(judge response), facet bitmap } — the
 * inputs never land on chain. This mirrors HealthVerdict.sol's stated invariant.
 *
 * Two-step on-chain write (per CRE EVM client):
 *   1. runtime.report(...)  -> a DON-signed Report over the encoded call data.
 *   2. EVMClient.writeReport(...) -> the DON forwards the report to the receiver.
 *
 * All SDK shapes used here are taken from @chainlink/cre-sdk@1.11.0 type defs.
 */

import {
  cre,
  ok,
  Runner,
  type Runtime,
  type HTTPPayload,
  hexToBase64,
} from '@chainlink/cre-sdk'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  hexToBytes,
  stringToHex,
  type Hex,
  type Address,
} from 'viem'

// --------------------------------------------------------------------------- config

interface AuthorizedKeyConfig {
  type: 'KEY_TYPE_ECDSA_EVM'
  publicKey: string
}

/** Shape of config/wf-goal-verification.json. */
interface WorkflowConfig {
  /** Vault secret owner (config-templating + secret ownership). */
  owner: string
  /** Endpoint that scores the goal. Local mock for simulation; real LLM in prod. */
  judgeUrl: string
  /** Name of the Vault DON secret holding the judge API key (referenced as {{.name}}). */
  judgeSecretName: string
  /** When true, simulation uses an inline deterministic judge instead of an HTTP call. */
  useMockJudge: boolean
  /** Receiver contract: HealthVerdict on Arc. Zero address until deployed (see README). */
  healthVerdictAddress: string
  /** Chain selector for the receiver chain (Arc testnet). */
  chainSelector: string
  /** Gas limit for the writeReport forward. */
  writeGasLimit: string
  /** Public keys allowed to sign incoming HTTP trigger requests. */
  authorizedKeys: AuthorizedKeyConfig[]
}

// ----------------------------------------------------------------- domain types

/** Inbound HTTP payload — derived summaries ONLY, never raw wearable data. */
interface GoalVerificationInput {
  poolId: number
  user: Address
  goalSpec: string
  baselineWeekAvg: number
  currentWindowAvg: number
  streakDays: number
}

type Confidence = 'low' | 'medium' | 'high'

/** What the judge (real or mock) returns. */
interface JudgeVerdict {
  verified: boolean
  confidence: Confidence
  multiplierBps: number
}

/** Result surfaced from the workflow (also what simulation prints). */
interface WorkflowResult {
  goalId: Hex
  verified: boolean
  confidence: Confidence
  multiplierBps: number
  digest: Hex
  bitmap: number
  receiver: string
  /** Hex of the ABI-encoded recordVerdict call that the report wraps. */
  encodedCall: Hex
  /** "live" once a real DON write succeeds; "encoded-only" in simulation. */
  writeMode: 'live' | 'encoded-only'
  txStatus?: string
}

// ----------------------------------------------------------------- constants

const CONFIDENCE_TO_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

// HealthVerdict facet bits (mirror HealthVerdict.sol FACET_* constants).
const FACET_WEARABLE = 1 << 0 // bit0: wearable data verified
const FACET_AI_ATTESTED = 1 << 2 // bit2: AI attested

// recordVerdict(bytes32,bool,uint8,bytes32,uint16) — exact HealthVerdict signature.
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

// ----------------------------------------------------------------- helpers

/** Decode the trigger payload bytes into our typed input, with validation. */
const parseInput = (payload: HTTPPayload): GoalVerificationInput => {
  const raw = new TextDecoder().decode(payload.input)
  const obj = JSON.parse(raw) as Partial<GoalVerificationInput>

  if (
    obj.poolId === undefined ||
    !obj.user ||
    !obj.goalSpec ||
    obj.baselineWeekAvg === undefined ||
    obj.currentWindowAvg === undefined ||
    obj.streakDays === undefined
  ) {
    throw new Error('invalid payload: expected { poolId, user, goalSpec, baselineWeekAvg, currentWindowAvg, streakDays }')
  }

  return {
    poolId: Number(obj.poolId),
    user: obj.user as Address,
    goalSpec: String(obj.goalSpec),
    baselineWeekAvg: Number(obj.baselineWeekAvg),
    currentWindowAvg: Number(obj.currentWindowAvg),
    streakDays: Number(obj.streakDays),
  }
}

/**
 * computeGoalId — must match HealthVerdict.computeGoalId:
 *   keccak256(abi.encode(uint256 poolId, address participant))
 */
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

/**
 * Deterministic local mock judge. Used ONLY in simulation (config.useMockJudge).
 * Pure function of the derived summaries — no network, no credentials. Tier:
 *   - improvement vs baseline AND a streak of >= 5 days  -> high
 *   - improvement OR a streak of >= 3 days               -> medium
 *   - otherwise                                          -> low (not verified)
 */
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

/** Coerce an arbitrary judge response into a strict JudgeVerdict. */
const normalizeVerdict = (raw: unknown): JudgeVerdict => {
  const v = raw as Partial<JudgeVerdict>
  const confidence: Confidence =
    v.confidence === 'high' || v.confidence === 'medium' ? v.confidence : 'low'
  return {
    verified: Boolean(v.verified),
    confidence,
    multiplierBps: Number.isFinite(Number(v.multiplierBps)) ? Number(v.multiplierBps) : 0,
  }
}

// ----------------------------------------------------------------- callback

const onGoalVerification = async (
  runtime: Runtime<WorkflowConfig>,
  payload: HTTPPayload,
): Promise<WorkflowResult> => {
  const cfg = runtime.config
  const input = parseInput(payload)

  // 1) Goal id, shared with the on-chain contract.
  const goalId = computeGoalId(input.poolId, input.user)

  // 2) Score the goal. Confidential HTTP keeps the summaries off the DON
  //    operators' view; the mock path keeps simulation credential-free.
  let verdict: JudgeVerdict
  if (cfg.useMockJudge) {
    verdict = mockJudge(input)
  } else {
    const client = new cre.capabilities.ConfidentialHTTPClient()
    const response = client
      .sendRequest(runtime, {
        request: {
          url: cfg.judgeUrl,
          method: 'POST',
          // Authorization is filled from a Vault DON secret; the value never
          // appears in the workflow code or logs. The summaries in the body are
          // encrypted to the enclave, so DON operators never see them either.
          multiHeaders: {
            Authorization: { values: [`Bearer {{.${cfg.judgeSecretName}}}`] },
            'Content-Type': { values: ['application/json'] },
          },
          bodyString: JSON.stringify({
            goalSpec: input.goalSpec,
            baselineWeekAvg: input.baselineWeekAvg,
            currentWindowAvg: input.currentWindowAvg,
            streakDays: input.streakDays,
          }),
        },
        vaultDonSecrets: [{ key: cfg.judgeSecretName, owner: cfg.owner }],
      })
      .result()

    if (!ok(response)) {
      throw new Error(`judge request failed: status ${response.statusCode}`)
    }
    const body = new TextDecoder().decode(response.body)
    verdict = normalizeVerdict(JSON.parse(body))
  }

  runtime.log(
    `verdict for goal ${goalId}: verified=${verdict.verified} confidence=${verdict.confidence}`,
  )

  // 3) digest = keccak of the (canonicalized) judge response. Never the inputs.
  const digest = keccak256(
    stringToHex(
      JSON.stringify({
        verified: verdict.verified,
        confidence: verdict.confidence,
        multiplierBps: verdict.multiplierBps,
      }),
    ),
  )

  // 4) Facet bitmap for the demo: AI attested (bit2) + wearable (bit0).
  const bitmap = FACET_AI_ATTESTED | FACET_WEARABLE

  // 5) Encode the receiver call exactly to HealthVerdict.recordVerdict.
  const encodedCall = encodeFunctionData({
    abi: RECORD_VERDICT_ABI,
    functionName: 'recordVerdict',
    args: [goalId, verdict.verified, CONFIDENCE_TO_U8[verdict.confidence], digest, bitmap],
  })

  // 6) DON-signed report over the encoded call data.
  const report = runtime
    .report({
      encodedPayload: hexToBase64(encodedCall),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
    .result()

  const base: WorkflowResult = {
    goalId,
    verified: verdict.verified,
    confidence: verdict.confidence,
    multiplierBps: verdict.multiplierBps,
    digest,
    bitmap,
    receiver: cfg.healthVerdictAddress,
    encodedCall,
    writeMode: 'encoded-only',
  }

  // 7) Forward the report to HealthVerdict.recordVerdict via the EVM client.
  //    Skipped when the receiver is unset (HealthVerdict not yet deployed) so
  //    simulation still produces the full signed report for inspection.
  const receiverUnset = /^0x0{40}$/i.test(cfg.healthVerdictAddress)
  if (receiverUnset) {
    return base
  }

  const evm = new cre.capabilities.EVMClient(BigInt(cfg.chainSelector))
  const writeResult = evm
    .writeReport(runtime, {
      receiver: hexToBytes(cfg.healthVerdictAddress as Hex),
      report,
      gasConfig: { gasLimit: cfg.writeGasLimit },
    })
    .result()

  return {
    ...base,
    writeMode: 'live',
    txStatus: writeResult.txStatus !== undefined ? String(writeResult.txStatus) : undefined,
  }
}

// ----------------------------------------------------------------- wiring

/**
 * initWorkflow binds the HTTP trigger to the callback. authorizedKeys gate which
 * signed requests the gateway accepts.
 */
const initWorkflow = (config: WorkflowConfig) => {
  const http = new cre.capabilities.HTTPCapability()
  const trigger = http.trigger({ authorizedKeys: config.authorizedKeys })
  return [cre.handler(trigger, onGoalVerification)]
}

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<WorkflowConfig>()
  await runner.run(initWorkflow)
}

main()

// Exported for unit/local testing without the CRE runtime.
export { computeGoalId, mockJudge, normalizeVerdict, FACET_AI_ATTESTED, FACET_WEARABLE }
