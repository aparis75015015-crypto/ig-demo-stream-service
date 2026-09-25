import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LightstreamerClient, Subscription } from 'lightstreamer-client-node';

const cfg = {
  base: 'https://demo-api.ig.com/gateway/deal',
  apiKey: process.env.IG_API_KEY,
  identifier: process.env.IG_IDENTIFIER,
  password: process.env.IG_PASSWORD,
  epic: process.env.IG_GOLD_EPIC || 'CS.D.CFEGOLD.CFE.IP',
  port: Number(process.env.PORT || 3000),
  cacheFile: process.env.CACHE_FILE || '/data/gold-candles.json',
  maxQuoteAgeMs: Number(process.env.MAX_QUOTE_AGE_MS || 90_000),
  bootstrapHistory: process.env.BOOTSTRAP_HISTORY === 'true',
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY || '',
};

for (const [key, value] of Object.entries({
  IG_API_KEY: cfg.apiKey,
  IG_IDENTIFIER: cfg.identifier,
  IG_PASSWORD: cfg.password,
})) if (!value) throw new Error(`Missing required secret: ${key}`);

const frames = ['1m', '5m', '15m', '30m', '1h', '4h'];
const state = {
  mode: 'IG_DEMO_ONLY', source: 'IG_LIGHTSTREAMER', status: 'STARTING',
  connected: false, lastTickAt: null, lastCandleAt: null, lastError: null,
  bootstrapErrors: [],
  reconnects: 0, sessionStartedAt: null, marketStatus: 'UNKNOWN',
  quote: null, candles: Object.fromEntries(frames.map(f => [f, []])),
};
let lsClient = null;
let persistTimer = null;
let session = null;
let igBootstrapAttempted = false;

const n = value => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};
const mid = (bid, ask) => n(bid) !== null && n(ask) !== null ? (n(bid) + n(ask)) / 2 : n(bid) ?? n(ask);

function upsert(frame, candle) {
  if (!candle?.time || !Number.isFinite(candle.open) || !Number.isFinite(candle.close)) return;
  const rows = state.candles[frame];
  const i = rows.findIndex(x => x.time === candle.time);
  if (i >= 0) rows[i] = { ...rows[i], ...candle };
  else rows.push(candle);
  rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (rows.length > 300) rows.splice(0, rows.length - 300);
  state.lastCandleAt = new Date().toISOString();
  schedulePersist();
}

function bucketStart(iso, minutes) {
  const d = new Date(iso);
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms).toISOString();
}

function aggregate(sourceFrame, targetFrame, minutes) {
  const source = state.candles[sourceFrame];
  const groups = new Map();
  for (const c of source) {
    const key = bucketStart(c.time, minutes);
    const g = groups.get(key) || [];
    g.push(c); groups.set(key, g);
  }
  for (const [time, group] of groups) {
    group.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    upsert(targetFrame, {
      time, open: group[0].open, high: Math.max(...group.map(x => x.high)),
      low: Math.min(...group.map(x => x.low)), close: group.at(-1).close,
      complete: group.at(-1).complete === true, source: 'IG_LIGHTSTREAMER_AGGREGATED',
    });
  }
}

function onCandle(scale, frame, update) {
  const value = name => update.getValue(name);
  const timeMs = n(value('UTM'));
  const candle = {
    time: new Date(timeMs ?? Date.now()).toISOString(),
    open: mid(value('BID_OPEN'), value('OFR_OPEN')),
    high: mid(value('BID_HIGH'), value('OFR_HIGH')),
    low: mid(value('BID_LOW'), value('OFR_LOW')),
    close: mid(value('BID_CLOSE'), value('OFR_CLOSE')),
    complete: value('CONS_END') === '1', source: 'IG_LIGHTSTREAMER', scale,
  };
  upsert(frame, candle);
  // UTM is the candle bucket timestamp, not the time the stream update arrived.
  // Using it for freshness makes a healthy hourly stream look ~60 minutes stale.
  state.lastTickAt = new Date().toISOString();
  state.quote = {
    symbol: 'XAUUSD', epic: cfg.epic, price: candle.close,
    bid: n(value('BID_CLOSE')), offer: n(value('OFR_CLOSE')),
    updatedAt: state.lastTickAt, candleAt: candle.time,
    source: 'IG_LIGHTSTREAMER', mode: 'DEMO',
  };
  state.lastError = null;
  if (frame === '5m') { aggregate('5m', '15m', 15); aggregate('5m', '30m', 30); }
  if (frame === '1h') aggregate('1h', '4h', 240);
}

async function persist() {
  const dir = dirname(cfg.cacheFile);
  await mkdir(dir, { recursive: true });
  const tmp = `${cfg.cacheFile}.tmp`;
  await writeFile(tmp, JSON.stringify({ candles: state.candles, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(tmp, cfg.cacheFile);
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist().catch(e => { state.lastError = `persist: ${e.message}`; }), 1000);
}
async function restore() {
  try {
    const saved = JSON.parse(await readFile(cfg.cacheFile, 'utf8'));
    for (const f of frames) if (Array.isArray(saved?.candles?.[f])) state.candles[f] = saved.candles[f].slice(-300);
  } catch (e) {
    if (e.code !== 'ENOENT') state.lastError = `restore: ${e.message}`;
  }
}

async function bootstrapFromTwelveData() {
  if (!cfg.twelveDataApiKey) return;
  const intervals = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h' };
  for (const [frame, interval] of Object.entries(intervals)) {
    if (state.candles[frame].length >= 50) continue;
    const qs = new URLSearchParams({ symbol: 'XAU/USD', interval, outputsize: '100', order: 'asc', apikey: cfg.twelveDataApiKey });
    const res = await fetch(`https://api.twelvedata.com/time_series?${qs}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.values)) {
      state.lastError = `Twelve Data bootstrap ${frame}: ${body.message || res.status}`;
      continue;
    }
    for (const row of body.values) upsert(frame, {
      time: new Date(`${row.datetime.replace(' ', 'T')}Z`).toISOString(),
      open: n(row.open), high: n(row.high), low: n(row.low), close: n(row.close),
      complete: true, source: 'TWELVE_DATA_BOOTSTRAP',
    });
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  await persist();
}

async function login() {
  const res = await fetch(`${cfg.base}/session`, {
    method: 'POST',
    headers: { 'X-IG-API-KEY': cfg.apiKey, Version: '2', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier: cfg.identifier, password: cfg.password }),
  });
  const body = await res.json().catch(() => ({}));
  const cst = res.headers.get('cst');
  const xst = res.headers.get('x-security-token');
  if (!res.ok || !cst || !xst || !body.lightstreamerEndpoint) {
    throw new Error(`IG session failed (${res.status}): ${body.errorCode || 'missing streaming credentials'}`);
  }
  session = { cst, xst, endpoint: body.lightstreamerEndpoint, accountId: body.currentAccountId, startedAt: Date.now() };
  state.sessionStartedAt = new Date().toISOString();
  return session;
}

async function bootstrapFromIg(s) {
  if (igBootstrapAttempted) return;
  igBootstrapAttempted = true;
  const resolutions = {
    '1m': 'MINUTE', '5m': 'MINUTE_5', '15m': 'MINUTE_15',
    '30m': 'MINUTE_30', '1h': 'HOUR', '4h': 'HOUR_4',
  };
  for (const [frame, resolution] of Object.entries(resolutions)) {
    if (state.candles[frame].length >= 50) continue;
    try {
      const qs = new URLSearchParams({ resolution, max: '50', pageSize: '0' });
      const res = await fetch(`${cfg.base}/prices/${encodeURIComponent(cfg.epic)}?${qs}`, {
        headers: {
          'X-IG-API-KEY': cfg.apiKey, 'CST': s.cst,
          'X-SECURITY-TOKEN': s.xst, 'Version': '3', 'Accept': 'application/json',
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.prices)) {
        const message = `IG bootstrap ${frame}: ${body.errorCode || res.status}`;
        state.bootstrapErrors.push(message);
        state.lastError = message;
        continue;
      }
      for (const row of body.prices) {
        const p = side => mid(row?.[side]?.bid, row?.[side]?.ask);
        upsert(frame, {
          time: new Date(row.snapshotTimeUTC || `${row.snapshotTime.replace(' ', 'T')}Z`).toISOString(),
          open: p('openPrice'), high: p('highPrice'), low: p('lowPrice'), close: p('closePrice'),
          complete: true, source: 'IG_REST_BOOTSTRAP',
        });
      }
    } catch (e) {
      const message = `IG bootstrap ${frame}: ${e.message}`;
      state.bootstrapErrors.push(message);
      state.lastError = message;
    }
  }
  await persist().catch(e => { state.lastError = `persist: ${e.message}`; });
}

function subscribeChart(scale, frame) {
  const fields = ['UTM','BID_OPEN','BID_HIGH','BID_LOW','BID_CLOSE','OFR_OPEN','OFR_HIGH','OFR_LOW','OFR_CLOSE','CONS_END'];
  const sub = new Subscription('MERGE', [`CHART:${cfg.epic}:${scale}`], fields);
  sub.addListener({
    onItemUpdate: update => onCandle(scale, frame, update),
    onSubscriptionError: (code, message) => { state.lastError = `subscription ${scale}: ${code} ${message}`; },
  });
  lsClient.subscribe(sub);
}

async function connect() {
  state.status = 'CONNECTING';
  const s = await login();
  await bootstrapFromIg(s);
  if (lsClient) { try { lsClient.disconnect(); } catch {} }
  lsClient = new LightstreamerClient(s.endpoint);
  lsClient.connectionDetails.setUser(s.accountId);
  lsClient.connectionDetails.setPassword(`CST-${s.cst}|XST-${s.xst}`);
  lsClient.addListener({ onStatusChange: status => {
    state.status = status;
    state.connected = status.startsWith('CONNECTED:');
    if (status.startsWith('DISCONNECTED')) state.reconnects += 1;
  }});
  lsClient.connect();
  subscribeChart('1MINUTE', '1m');
  subscribeChart('5MINUTE', '5m');
  subscribeChart('HOUR', '1h');
}

function quality() {
  const ageMs = state.lastTickAt ? Date.now() - Date.parse(state.lastTickAt) : Infinity;
  const counts = Object.fromEntries(frames.map(f => [f, state.candles[f].length]));
  const warm = frames.every(f => counts[f] >= 50);
  const fresh = ageMs <= cfg.maxQuoteAgeMs;
  return { ok: state.connected && fresh && warm, connected: state.connected, fresh, warm, ageMs, counts };
}

const app = express();
app.get('/health', (_req, res) => {
  const q = quality();
  res.status(q.ok ? 200 : 503).json({ service: 'gold-ig-demo-stream', mode: state.mode, ...q, status: state.status, lastError: state.lastError, bootstrapErrors: state.bootstrapErrors, reconnects: state.reconnects });
});
app.get('/bundle', (_req, res) => {
  const q = quality();
  res.status(q.ok ? 200 : 503).json({ data_valid: q.ok, source: state.source, mode: state.mode, quote: state.quote, marketStatus: state.marketStatus, candles: state.candles, quality: q });
});

await restore();
await bootstrapFromTwelveData().catch(e => { state.lastError = `bootstrap: ${e.message}`; });
connect().catch(e => { state.status = 'FAILED'; state.lastError = e.message; });
setInterval(() => {
  if (!session || Date.now() - session.startedAt > 5 * 60 * 60_000 || !state.connected) {
    connect().catch(e => { state.status = 'FAILED'; state.lastError = e.message; });
  }
}, 60_000).unref();
app.listen(cfg.port, () => console.log(`gold IG Demo stream service listening on ${cfg.port}`));
