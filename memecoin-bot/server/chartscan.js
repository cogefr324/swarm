// "Only-green chart" detector. A real coin's chart goes up AND down. A bot-driven fake climbs in an almost straight line with
// tiny pullbacks. Uses GeckoTerminal's free OHLCV candles (queued, cached) and three numbers:
//   gain      total move over the window
//   maxDD     biggest peak-to-trough drop inside the window (real pumps give back 15-40%; fakes give back a few %)
//   efficiency  |sum of candle returns| / sum of |candle returns|  (1 = perfectly straight line, ~0.1 = normal random chart)
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const CHART_CFG = {
  minGain: num('CHART_MIN_GAIN', 0.2),      // only judge coins that climbed at least this much (0.2 = +20%)
  maxDrawdown: num('CHART_MAX_DD', 0.10),   // ...with no pullback bigger than this
  minEfficiency: num('CHART_MIN_EFF', 0.5),
  minGreen: num('CHART_MIN_GREEN', 0.85),
  minCandles: num('CHART_MIN_CANDLES', 40),
  gapMs: num('CHART_GAP_MS', 7000),
  ttlMin: num('CHART_TTL_MIN', 60),
};

// candles: [[ts, open, high, low, close, volume], ...] oldest -> newest
export function analyseCandles(candles, cfg = CHART_CFG) {
  const c = (candles || []).filter((x) => x && x[4] > 0 && x[1] > 0);
  if (c.length < cfg.minCandles) return { status: 'unknown', candles: c.length };
  const closes = c.map((x) => x[4]);
  const green = c.filter((x) => x[4] >= x[1]).length / c.length;
  let sum = 0, abs = 0, peak = closes[0], maxDD = 0;
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i] - closes[i - 1]) / closes[i - 1];
    sum += r; abs += Math.abs(r);
    peak = Math.max(peak, closes[i]);
    maxDD = Math.max(maxDD, (peak - closes[i]) / peak);
  }
  const gain = closes[closes.length - 1] / closes[0] - 1;
  const eff = abs > 0 ? Math.abs(sum) / abs : 0;
  const smooth = gain >= cfg.minGain && maxDD < cfg.maxDrawdown && (eff >= cfg.minEfficiency || green >= cfg.minGreen);
  return { status: smooth ? 'fake' : 'real', candles: c.length, gain: +gain.toFixed(3), maxDD: +maxDD.toFixed(3), efficiency: +eff.toFixed(2), green: +green.toFixed(2) };
}

async function fetchCandles(pool, young) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=${young ? 5 : 15}&limit=100`;
  const r = await fetch(url, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(9000) });
  if (r.status === 429) return { rate: true };
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const j = await r.json();
  const list = j?.data?.attributes?.ohlcv_list || [];
  return { candles: list.slice().sort((a, b) => a[0] - b[0]) };
}

const cache = new Map(); // pool -> { at, res }
const queue = new Map();
let started = false, busy = false, pauseUntil = 0;
const stats = { scanned: 0, fake: 0, rateLimited: 0 };
export const chartStats = () => ({ ...stats, queued: queue.size, cached: cache.size });
export function chartState(pool) {
  const c = cache.get(pool);
  return c ? c.res : { status: queue.has(pool) ? 'pending' : 'unqueued' };
}
export function requestChartScan(pool, { prio = 0, rank = 0, young = false } = {}) {
  if (!pool) return;
  const c = cache.get(pool);
  if (c && Date.now() - c.at < (c.res.status === 'unknown' ? 10 : CHART_CFG.ttlMin) * 60000) return;
  const q = queue.get(pool);
  queue.set(pool, { prio, rank, young, wanted: Date.now(), queuedAt: q?.queuedAt || Date.now() });
  if (!started) { started = true; setInterval(pump, CHART_CFG.gapMs).unref(); }
}
async function pump() {
  if (busy || Date.now() < pauseUntil) return;
  for (const [p, q] of queue) if (Date.now() - q.wanted > 5 * 60000) queue.delete(p);
  if (!queue.size) return;
  const [pool, q] = [...queue.entries()].sort((a, b) => a[1].prio - b[1].prio || a[1].rank - b[1].rank || a[1].queuedAt - b[1].queuedAt)[0];
  queue.delete(pool);
  busy = true;
  try {
    const f = await fetchCandles(pool, q.young);
    if (f.rate) { stats.rateLimited++; pauseUntil = Date.now() + 30000; queue.set(pool, { ...q, wanted: Date.now() }); }
    else {
      const res = f.error ? { status: 'unknown', error: f.error } : analyseCandles(f.candles);
      cache.set(pool, { at: Date.now(), res }); stats.scanned++; if (res.status === 'fake') stats.fake++;
    }
  } catch { /* next request retries */ } finally { busy = false; }
}
