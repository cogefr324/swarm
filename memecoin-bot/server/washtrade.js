// Fake-volume (wash trading) detector. Free data only: GeckoTerminal's pool trades endpoint (last ~300 swaps with the trader wallet)
// plus free Solana RPC to trace who funded the busiest wallets ("side wallets").
//
// Idea: real volume comes from MANY different wallets that mostly buy OR sell. Fake volume comes from a handful of wallets (or a
// group of wallets funded by one source) that buy and sell to each other, so their buys and sells cancel out.
//   washPct   = share of volume that is round-tripped (for each wallet or linked group: 2 x min(bought, sold) / total volume)
//   top5Share = share of volume done by the 5 busiest wallets
//   uniqueRatio = distinct wallets / trades
// Side wallets are found by tracing each busy wallet's first funder + funding time and merging wallets that share them.
import { oldest, rpc } from './onchain-bundle.js';

const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const WASH_CFG = {
  maxWashPct: num('WASH_MAX_PCT', 35),
  maxTop5Share: num('WASH_MAX_TOP5_PCT', 70),
  minUniqueRatio: num('WASH_MIN_UNIQUE_RATIO', 0.2),
  minTrades: num('WASH_MIN_TRADES', 40),
  fundWindowS: num('WASH_FUND_WINDOW_S', 300),
  gapMs: num('WASH_GAP_MS', 4500),     // GeckoTerminal free limit is ~30/min and the feed already uses it
  ttlMin: num('WASH_TTL_MIN', 45),
  traceWallets: num('WASH_TRACE_WALLETS', 8),
};

// ---- pure analysis (unit-testable). trades: [{ wallet, kind:'buy'|'sell', usd, t }]; funding: Map wallet -> { funder, fundT } ----
export function analyseTrades(trades, funding = new Map(), cfg = WASH_CFG) {
  const out = { status: 'unknown', trades: trades.length, wallets: 0, uniqueRatio: 0, top5Share: 0, washPct: 0, groupWashPct: 0, reasons: [] };
  const valid = trades.filter((x) => x.wallet && x.usd > 0 && (x.kind === 'buy' || x.kind === 'sell'));
  if (valid.length < cfg.minTrades) { out.error = `only ${valid.length} trades to analyse`; return out; }
  const total = valid.reduce((a, x) => a + x.usd, 0);
  const w = new Map();
  for (const x of valid) { const s = w.get(x.wallet) || { buy: 0, sell: 0, n: 0 }; s[x.kind] += x.usd; s.n++; w.set(x.wallet, s); }
  out.wallets = w.size;
  out.uniqueRatio = +(w.size / valid.length).toFixed(3);
  const byVol = [...w.entries()].map(([k, s]) => ({ k, ...s, vol: s.buy + s.sell })).sort((a, b) => b.vol - a.vol);
  out.top5Share = +(byVol.slice(0, 5).reduce((a, s) => a + s.vol, 0) / total * 100).toFixed(1);
  out.washPct = +(byVol.reduce((a, s) => a + 2 * Math.min(s.buy, s.sell), 0) / total * 100).toFixed(1);
  // side wallets: merge wallets that share a funder, or were funded within a few minutes of each other
  const busy = byVol.slice(0, cfg.traceWallets).filter((s) => funding.has(s.k));
  const parent = new Map(busy.map((s) => [s.k, s.k]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (let i = 0; i < busy.length; i++) for (let j = i + 1; j < busy.length; j++) {
    const a = funding.get(busy[i].k), b = funding.get(busy[j].k);
    if ((a.funder && a.funder === b.funder) || (a.fundT && b.fundT && Math.abs(a.fundT - b.fundT) <= cfg.fundWindowS)) parent.set(find(busy[i].k), find(busy[j].k));
  }
  const groups = new Map();
  for (const s of busy) { const r = find(s.k); const g = groups.get(r) || { buy: 0, sell: 0, wallets: 0 }; g.buy += s.buy; g.sell += s.sell; g.wallets++; groups.set(r, g); }
  const gw = [...groups.values()].filter((g) => g.wallets >= 2).reduce((a, g) => a + 2 * Math.min(g.buy, g.sell), 0);
  const solo = byVol.filter((s) => !busy.some((b) => b.k === s.k)).reduce((a, s) => a + 2 * Math.min(s.buy, s.sell), 0);
  const grouped = byVol.filter((s) => busy.some((b) => b.k === s.k) && groups.get(find(s.k)).wallets < 2).reduce((a, s) => a + 2 * Math.min(s.buy, s.sell), 0);
  out.groupWashPct = +((gw + solo + grouped) / total * 100).toFixed(1); // wash volume once linked side wallets are treated as one trader
  out.linkedGroups = [...groups.values()].filter((g) => g.wallets >= 2).map((g) => ({ wallets: g.wallets, boughtUsd: Math.round(g.buy), soldUsd: Math.round(g.sell) }));
  const wash = Math.max(out.washPct, out.groupWashPct);
  if (wash > cfg.maxWashPct) out.reasons.push(`${wash.toFixed(0)}% of volume is round-tripped (buys and sells cancel out)`);
  if (out.top5Share > cfg.maxTop5Share && out.uniqueRatio < 0.5) out.reasons.push(`5 wallets do ${out.top5Share.toFixed(0)}% of the volume`);
  if (out.uniqueRatio < cfg.minUniqueRatio) out.reasons.push(`only ${w.size} wallets behind ${valid.length} trades`);
  out.status = out.reasons.length ? 'fake' : 'real';
  return out;
}

// ---- data: GeckoTerminal trades (free) ----
async function fetchTrades(pool) {
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades`, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(9000) });
  if (r.status === 429) return { rate: true };
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const j = await r.json();
  const trades = (j.data || []).map((d) => { const a = d.attributes || {}; return { wallet: a.tx_from_address, kind: a.kind, usd: Number(a.volume_in_usd), t: a.block_timestamp ? Date.parse(a.block_timestamp) / 1000 : null }; });
  return { trades };
}
async function fundingOf(wallet) {
  const w = await oldest(wallet);
  if (!w || !w.sig || w.busy || w.error || w.none) return null;
  const tx = await rpc('getTransaction', [w.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  for (const ix of tx.result?.transaction?.message?.instructions || []) {
    if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === wallet) return { funder: ix.parsed.info.source, fundT: w.time };
  }
  return null;
}
export async function scanWash(pool) {
  const f = await fetchTrades(pool);
  if (f.rate) return { status: 'unknown', error: 'rate limited', rate: true };
  if (f.error) return { status: 'unknown', error: f.error };
  const first = analyseTrades(f.trades);
  if (first.status === 'unknown') return first;
  // trace side wallets only when the plain numbers are not already conclusive
  const vol = new Map();
  for (const x of f.trades) vol.set(x.wallet, (vol.get(x.wallet) || 0) + (x.usd || 0));
  const busy = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, WASH_CFG.traceWallets).map(([k]) => k);
  const funding = new Map();
  await Promise.all(busy.map(async (wl) => { try { const x = await fundingOf(wl); if (x) funding.set(wl, x); } catch { /* skip */ } }));
  return analyseTrades(f.trades, funding);
}

// ---- queue + cache ----
const cache = new Map(); // pool -> { at, res }
const queue = new Map(); // pool -> { rank, prio, wanted }
let started = false, busy = false;
const stats = { scanned: 0, fake: 0, rateLimited: 0 };
export const washStats = () => ({ ...stats, queued: queue.size, cached: cache.size });
export function washState(pool) {
  const c = cache.get(pool);
  if (!c) return { status: queue.has(pool) ? 'pending' : 'unqueued' };
  return { ...c.res, stale: Date.now() - c.at > WASH_CFG.ttlMin * 60000 };
}
export function requestWashScan(pool, { prio = 0, rank = 0 } = {}) {
  if (!pool) return;
  const c = cache.get(pool);
  if (c && Date.now() - c.at < (c.res.status === 'unknown' ? 5 : WASH_CFG.ttlMin) * 60000) return;
  const q = queue.get(pool);
  queue.set(pool, { prio, rank, wanted: Date.now(), queuedAt: q?.queuedAt || Date.now() });
  if (!started) { started = true; setInterval(pump, WASH_CFG.gapMs).unref(); }
}
let pauseUntil = 0;
async function pump() {
  if (busy || Date.now() < pauseUntil) return;
  for (const [p, q] of queue) if (Date.now() - q.wanted > 5 * 60000) queue.delete(p);
  if (!queue.size) return;
  const [pool] = [...queue.entries()].sort((a, b) => a[1].prio - b[1].prio || a[1].rank - b[1].rank || a[1].queuedAt - b[1].queuedAt)[0];
  queue.delete(pool);
  busy = true;
  try {
    const res = await scanWash(pool);
    if (res.rate) { stats.rateLimited++; pauseUntil = Date.now() + 30000; queue.set(pool, { prio: 0, rank: 0, wanted: Date.now(), queuedAt: Date.now() }); }
    else { cache.set(pool, { at: Date.now(), res }); stats.scanned++; if (res.status === 'fake') stats.fake++; }
  } catch { /* next request retries */ } finally { busy = false; }
}
