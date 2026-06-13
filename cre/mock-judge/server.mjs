/**
 * Local mock judge endpoint for wf-goal-verification.
 *
 * This stands in for the production LLM/scoring service so the CONFIDENTIAL HTTP
 * path of the workflow can be exercised end to end without external credentials.
 * It is the HTTP-server form of the inline `mockJudge` in the workflow; the
 * inline version is used when config.useMockJudge is true, this server is used
 * when useMockJudge is false and config.judgeUrl points here.
 *
 * Run:  node mock-judge/server.mjs   (listens on :8787, POST /judge)
 * Auth: accepts any Bearer token (the workflow injects one from the Vault DON
 *       secret; we do not validate it here — this is a stub).
 *
 * Deterministic: same input -> same verdict, so simulations are reproducible.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_JUDGE_PORT ?? 8787)

/** Same tiering rule as the inline mockJudge in the workflow. */
function score({ baselineWeekAvg = 0, currentWindowAvg = 0, streakDays = 0 }) {
  const improved = currentWindowAvg > baselineWeekAvg
  const gain = baselineWeekAvg > 0 ? (currentWindowAvg - baselineWeekAvg) / baselineWeekAvg : 0

  if (improved && streakDays >= 5) {
    return { verified: true, confidence: 'high', multiplierBps: 12000 + Math.round(gain * 5000) }
  }
  if (improved || streakDays >= 3) {
    return { verified: true, confidence: 'medium', multiplierBps: 10500 }
  }
  return { verified: false, confidence: 'low', multiplierBps: 0 }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/judge')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let input = {}
    try {
      input = body ? JSON.parse(body) : {}
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad json' }))
      return
    }
    const verdict = score(input)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(verdict))
  })
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-judge] POST http://localhost:${PORT}/judge`)
})
