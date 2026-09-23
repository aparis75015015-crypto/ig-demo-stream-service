import express from 'express'

const app = express()
const cfg = {
  base: process.env.IG_API_BASE || 'https://demo-api.ig.com/gateway/deal',
  apiKey: process.env.IG_API_KEY,
  identifier: process.env.IG_IDENTIFIER,
  password: process.env.IG_PASSWORD,
  epic: process.env.IG_GOLD_EPIC || 'CS.D.CFEGOLD.CFE.IP',
  pollMs: Math.max(2000, Number(process.env.POLL_INTERVAL_MS || 5000)),
  port: Number(process.env.PORT || 3000),
  origin: process.env.ALLOWED_ORIGIN || 'https://goldagent.retool.com',
}

for (const [name, value] of Object.entries({ IG_API_KEY: cfg.apiKey, IG_IDENTIFIER: cfg.identifier, IG_PASSWORD: cfg.password })) {
  if (!value) throw new Error(`Missing required secret: ${name}`)
}

let session = null
let latest = { ok: false, source: 'IG Demo', mode: 'DEMO', error: 'Starting', updatedAt: null }
const listeners = new Set()

function safeCode(body) {
  return typeof body?.errorCode === 'string'
    ? body.errorCode.replace(/[^A-Za-z0-9._-]/g, '')
    : 'unknown'
}

async function login() {
  const res = await fetch(`${cfg.base}/session`, {
    method: 'POST',
    headers: {
      'X-IG-API-KEY': cfg.apiKey,
      Version: '2',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      identifier: cfg.identifier,
      password: cfg.password,
      encryptedPassword: false,
    }),
  })
  const body = await res.json().catch(() => ({}))
  const cst = res.headers.get('cst')
  const securityToken = res.headers.get('x-security-token')

  if (!res.ok || !cst || !securityToken) {
    throw new Error(`IG login failed (${res.status}; ${safeCode(body)})`)
  }

  session = { cst, securityToken }
}

function requestHeaders() {
  return {
    'X-IG-API-KEY': cfg.apiKey,
    CST: session.cst,
    'X-SECURITY-TOKEN': session.securityToken,
    Version: '3',
    Accept: 'application/json',
  }
}

async function igFetch(path) {
  if (!session) await login()

  let res = await fetch(`${cfg.base}${path}`, { headers: requestHeaders() })
  if (res.status === 401) {
    session = null
    await login()
    res = await fetch(`${cfg.base}${path}`, { headers: requestHeaders() })
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`IG request failed (${res.status}; ${safeCode(body)})`)
  return body
}

function publish(value) {
  latest = value
  const line = `data: ${JSON.stringify(value)}\n\n`
  for (const res of listeners) res.write(line)
}

async function tick() {
  try {
    const body = await igFetch(`/markets/${encodeURIComponent(cfg.epic)}`)
    const s = body.snapshot || {}
    const bid = Number(s.bid), offer = Number(s.offer)
    const price = Number.isFinite(bid) && Number.isFinite(offer) ? (bid + offer) / 2 : Number.isFinite(bid) ? bid : offer
    if (!Number.isFinite(price)) throw new Error('IG returned no valid price')
    publish({ ok: true, symbol: 'XAUUSD', epic: cfg.epic, bid, offer, price, marketStatus: s.marketStatus || 'UNKNOWN', source: 'IG Demo', mode: 'DEMO', updatedAt: new Date().toISOString() })
  } catch (error) {
    publish({ ok: false, symbol: 'XAUUSD', source: 'IG Demo', mode: 'DEMO', error: error.message, updatedAt: new Date().toISOString() })
  }
}

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', cfg.origin); res.setHeader('Vary', 'Origin'); next() })
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'ig-demo-stream',
  latestOk: latest.ok,
  error: latest.ok ? null : (latest.error || 'Unknown IG Demo error'),
  updatedAt: latest.updatedAt,
}))
app.get('/snapshot', (_req, res) => res.status(latest.ok ? 200 : 503).json(latest))
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders()
  listeners.add(res); res.write(`data: ${JSON.stringify(latest)}\n\n`)
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000)
  req.on('close', () => { clearInterval(heartbeat); listeners.delete(res) })
})

app.listen(cfg.port, () => { console.log(`IG Demo read-only stream listening on ${cfg.port}`); tick(); setInterval(tick, cfg.pollMs) })
