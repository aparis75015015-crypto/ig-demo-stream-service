import express from 'express'

const app = express()
const cfg = {
  base: process.env.IG_API_BASE || 'https://demo-api.ig.com/gateway/deal',
  apiKey: process.env.IG_API_KEY,
  identifier: process.env.IG_IDENTIFIER,
  password: process.env.IG_PASSWORD,
  goldEpic: process.env.IG_GOLD_EPIC || 'CS.D.CFEGOLD.CFE.IP',
  pollMs: Math.max(2000, Number(process.env.POLL_INTERVAL_MS || 5000)),
  port: Number(process.env.PORT || 3000),
  origin: process.env.ALLOWED_ORIGIN || '*',
}

for (const [name, value] of Object.entries({ IG_API_KEY: cfg.apiKey, IG_IDENTIFIER: cfg.identifier, IG_PASSWORD: cfg.password })) {
  if (!value) throw new Error(`Missing required secret: ${name}`)
}

const instruments = {
  XAUUSD: { label: '🥇 XAUUSD — Gold', search: 'Gold', epic: cfg.goldEpic },
  XAGUSD: { label: '🥈 XAGUSD — Silver', search: 'Silver' },
  BTCUSD: { label: '₿ BTCUSD — Bitcoin', search: 'Bitcoin', epic: 'CS.D.BITCOIN.CFD.IP' },
  ETHUSD: { label: 'Ξ ETHUSD — Ethereum', search: 'Ether' },
  SOLUSD: { label: '◎ SOLUSD — Solana', search: 'Solana' },
  XRPUSD: { label: '✕ XRPUSD — XRP', search: 'Ripple' },
  WTI: { label: '🛢️ WTI — US Oil', search: 'US Crude' },
  BRENT: { label: '🛢️ BRENT — Brent Oil', search: 'Brent Crude' },
  COPPER: { label: '🟠 COPPER — Copper', search: 'Copper' },
  EURUSD: { label: '💶 EURUSD', search: 'EUR/USD' },
  GBPUSD: { label: '💷 GBPUSD', search: 'GBP/USD' },
  USDJPY: { label: '💴 USDJPY', search: 'USD/JPY' },
}

let session = null
let latest = { ok: false, source: 'IG Demo', mode: 'DEMO', error: 'Starting', updatedAt: null }
const listeners = new Set()
const resolvedEpics = new Map()

function safeCode(body) {
  return typeof body?.errorCode === 'string' ? body.errorCode.replace(/[^A-Za-z0-9._-]/g, '') : 'unknown'
}

async function login() {
  const res = await fetch(`${cfg.base}/session`, {
    method: 'POST',
    headers: { 'X-IG-API-KEY': cfg.apiKey, Version: '2', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier: cfg.identifier, password: cfg.password, encryptedPassword: false }),
  })
  const body = await res.json().catch(() => ({}))
  const cst = res.headers.get('cst')
  const securityToken = res.headers.get('x-security-token')
  if (!res.ok || !cst || !securityToken) throw new Error(`IG login failed (${res.status}; ${safeCode(body)})`)
  session = { cst, securityToken }
}

function requestHeaders(version = '3') {
  return { 'X-IG-API-KEY': cfg.apiKey, CST: session.cst, 'X-SECURITY-TOKEN': session.securityToken, Version: version, Accept: 'application/json' }
}

async function igFetch(path, version = '3') {
  if (!session) await login()
  let res = await fetch(`${cfg.base}${path}`, { headers: requestHeaders(version) })
  if (res.status === 401) {
    session = null
    await login()
    res = await fetch(`${cfg.base}${path}`, { headers: requestHeaders(version) })
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`IG request failed (${res.status}; ${safeCode(body)})`)
  return body
}

function cleanSymbol(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '')
}

async function resolveEpic(symbol) {
  const key = cleanSymbol(symbol)
  const spec = instruments[key]
  if (!spec) throw new Error('Unsupported symbol')
  if (resolvedEpics.has(key)) return resolvedEpics.get(key)
  if (spec.epic) {
    resolvedEpics.set(key, spec.epic)
    return spec.epic
  }
  const result = await igFetch(`/markets?searchTerm=${encodeURIComponent(spec.search)}`, '1')
  const markets = Array.isArray(result.markets) ? result.markets : []
  const active = markets.find(m => m?.instrument?.epic && m?.snapshot?.marketStatus === 'TRADEABLE')
  const first = active || markets.find(m => m?.instrument?.epic)
  if (!first) throw new Error(`IG market not found for ${key}`)
  resolvedEpics.set(key, first.instrument.epic)
  return first.instrument.epic
}

function quoteFromSnapshot(symbol, epic, snapshot = {}) {
  const bid = Number(snapshot.bid)
  const offer = Number(snapshot.offer)
  const price = Number.isFinite(bid) && Number.isFinite(offer) ? (bid + offer) / 2 : Number.isFinite(bid) ? bid : offer
  if (!Number.isFinite(price)) throw new Error('IG returned no valid price')
  const change = Number(snapshot.netChange)
  const previousClose = Number.isFinite(change) ? price - change : price
  const now = Math.floor(Date.now() / 1000)
  return {
    ok: true,
    symbol,
    name: instruments[symbol].label,
    label: instruments[symbol].label,
    epic,
    bid,
    ask: offer,
    offer,
    price,
    close: price,
    previous_close: previousClose,
    change: Number.isFinite(change) ? change : 0,
    percent_change: Number(snapshot.percentageChange) || 0,
    timestamp: now,
    datetime: new Date(now * 1000).toISOString(),
    is_market_open: snapshot.marketStatus === 'TRADEABLE',
    marketStatus: snapshot.marketStatus || 'UNKNOWN',
    source: 'IG Demo',
    mode: 'DEMO',
    updatedAt: new Date().toISOString(),
    chart: { result: [{ meta: { symbol, regularMarketPrice: price, previousClose, chartPreviousClose: previousClose, exchangeName: 'IG Demo' }, timestamp: [now], indicators: { quote: [{ open: [price], high: [price], low: [price], close: [price] }] } }], error: null },
  }
}

async function getQuote(symbol) {
  const epic = await resolveEpic(symbol)
  const body = await igFetch(`/markets/${encodeURIComponent(epic)}`, '3')
  return quoteFromSnapshot(symbol, epic, body.snapshot || {})
}

function publish(value) {
  latest = value
  const line = `data: ${JSON.stringify(value)}\n\n`
  for (const res of listeners) res.write(line)
}

async function tick() {
  try {
    publish(await getQuote('XAUUSD'))
  } catch (error) {
    publish({ ok: false, symbol: 'XAUUSD', label: instruments.XAUUSD.label, source: 'IG Demo', mode: 'DEMO', error: error.message, updatedAt: new Date().toISOString() })
  }
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', cfg.origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Cache-Control', 'no-store')
  next()
})

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'ig-demo-stream',
  mode: 'DEMO',
  instruments: Object.keys(instruments),
  latestOk: latest.ok,
  error: latest.ok ? null : (latest.error || 'Unknown IG Demo error'),
  updatedAt: latest.updatedAt,
}))

app.get('/snapshot', (_req, res) => res.status(latest.ok ? 200 : 503).json(latest))

app.get('/quote/:symbol', async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol)
  try {
    const quote = await getQuote(symbol)
    res.json(quote)
  } catch (error) {
    res.status(error.message === 'Unsupported symbol' ? 404 : 503).json({ ok: false, symbol, source: 'IG Demo', mode: 'DEMO', error: error.message, updatedAt: new Date().toISOString() })
  }
})

app.get('/prices/:symbol', async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol)
  const allowedResolutions = new Set(['MINUTE', 'MINUTE_2', 'MINUTE_3', 'MINUTE_5', 'MINUTE_10', 'MINUTE_15', 'MINUTE_30', 'HOUR', 'HOUR_2', 'HOUR_3', 'HOUR_4', 'DAY', 'WEEK', 'MONTH'])
  const resolution = allowedResolutions.has(String(req.query.resolution || '').toUpperCase()) ? String(req.query.resolution).toUpperCase() : 'MINUTE_5'
  const max = Math.min(500, Math.max(10, Number(req.query.max || 100)))
  try {
    const epic = await resolveEpic(symbol)
    const body = await igFetch(`/prices/${encodeURIComponent(epic)}?resolution=${resolution}&max=${max}`, '3')
    const rows = (Array.isArray(body.prices) ? body.prices : []).map(p => {
      const mid = pair => {
        const bid = Number(pair?.bid), ask = Number(pair?.ask)
        return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number.isFinite(bid) ? bid : ask
      }
      const iso = p.snapshotTimeUTC || p.snapshotTime
      const timestamp = Math.floor(new Date(iso).getTime() / 1000)
      return { datetime: iso, timestamp, open: mid(p.openPrice), high: mid(p.highPrice), low: mid(p.lowPrice), close: mid(p.closePrice), volume: Number(p.lastTradedVolume) || 0 }
    }).filter(r => Number.isFinite(r.timestamp) && Number.isFinite(r.close))
    const timestamp = rows.map(r => r.timestamp)
    const q = { open: rows.map(r => r.open), high: rows.map(r => r.high), low: rows.map(r => r.low), close: rows.map(r => r.close), volume: rows.map(r => r.volume) }
    const last = rows.at(-1)?.close
    res.json({ ok: true, symbol, label: instruments[symbol].label, epic, resolution, source: 'IG Demo', mode: 'DEMO', values: rows.slice().reverse(), prices: body.prices || [], metadata: body.metadata || {}, chart: { result: [{ meta: { symbol, regularMarketPrice: last, exchangeName: 'IG Demo' }, timestamp, indicators: { quote: [q] } }], error: null } })
  } catch (error) {
    res.status(error.message === 'Unsupported symbol' ? 404 : 503).json({ ok: false, symbol, source: 'IG Demo', mode: 'DEMO', error: error.message, updatedAt: new Date().toISOString() })
  }
})

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  listeners.add(res)
  res.write(`data: ${JSON.stringify(latest)}\n\n`)
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000)
  req.on('close', () => { clearInterval(heartbeat); listeners.delete(res) })
})

app.listen(cfg.port, () => {
  console.log(`IG Demo multi-market service listening on ${cfg.port}`)
  tick()
  setInterval(tick, cfg.pollMs)
})
