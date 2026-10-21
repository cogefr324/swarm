// Free, on-chain hidden-bundle detector (no paid API, no third-party scoring). It reads the chain through free Solana RPCs
// (or your Helius FREE key) and answers one question: do several "unrelated" top holders actually act as ONE entity?
//
// For the top holders of a coin we look at (1) when each first received the token, (2) who first funded each wallet and when,
// (3) whether the wallet is a fresh burner, (4) whether it bought inside the launch window, (5) how similar the holdings are.
// Two wallets are linked only when at least TWO different signals agree (a shared funder alone is not enough - exchanges
// fund thousands of wallets). Linked wallets form a cluster; its combined share of supply is the "bundled %".
//
// Limits (be honest): funding is followed one hop only; wallets with >3000 transactions can't be traced to their first
// funder; free RPCs are slow, so coins are scanned by a background queue and results are cached (and saved to disk).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'bundle-cache.json');
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);

export const BUNDLE_CFG = {
  maxClusterPct: num('BUNDLE_MAX_CLUSTER_PCT', 12),     // one confirmed cluster holding more than this % of supply -> bundled
  maxConnected: num('BUNDLE_MAX_CONNECTED', 8),         // this many of the top-20 holders linked together -> bundled
  launchWindowS: num('BUNDLE_LAUNCH_WINDOW_S', 45),     // buys this close together count as one signal
  fundWindowS: num('BUNDLE_FUND_WINDOW_S', 120),        // wallets funded this close together count as one signal
  freshMin: num('BUNDLE_FRESH_MIN', 20),                // wallet's first tx <= this many minutes before it bought the token = burner
  wallets: num('BUNDLE_WALLETS', 12),                   // top holders investigated per coin (RPC cost)
  budgetMs: num('BUNDLE_BUDGET_MS', 45000),
  concurrency: num('BUNDLE_CONCURRENCY', 2),            // coins scanned in parallel
  okTtlMin: num('BUNDLE_OK_TTL_MIN', 30),
  badTtlMin: num('BUNDLE_BAD_TTL_MIN', 360),
  retryMin: num('BUNDLE_RETRY_MIN', 5),
};

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- RPC (free endpoints, rotation + cooldown)
function endpoints() {
  const l = [];
  if (env.SOLANA_RPC_URL) l.push(env.SOLANA_RPC_URL);
  if (env.HELIUS_API_KEY) l.push(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`); // free tier
  l.push('https://solana.api.onfinality.io/public', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com');
  return l;
}
const cool = new Map();
let rr = 0;
let inFlight = 0;
const waiters = [];
async function slot() { // global cap on simultaneous RPC calls so free endpoints are not hammered
  if (inFlight >= 5) await new Promise((r) => waiters.push(r));
  inFlight++;
}
const release = () => { inFlight--; waiters.shift()?.(); };
export async function rpc(method, params) {
  const eps = endpoints();
  let err = 'no RPC endpoint available';
  await slot();
  try {
    for (let k = 0; k < eps.length * 2; k++) {
      const url = eps[(rr + k) % eps.length];
      if (Date.now() < (cool.get(url) || 0)) continue;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(9000) });
        if (r.status === 429 || r.status === 403 || r.status >= 500) { cool.set(url, Date.now() + 15000); err = `HTTP ${r.status}`; rr++; continue; }
        const j = await r.json();
        if (j.error) { err = j.error.message || 'rpc error'; if (/rate|limit|too many/i.test(err)) { cool.set(url, Date.now() + 15000); rr++; continue; } return { ok: false, error: err }; }
        return { ok: true, result: j.result };
      } catch (e) { err = e.name === 'TimeoutError' ? 'timeout' : e.message; cool.set(url, Date.now() + 8000); rr++; }
    }
  } finally { release(); }
  return { ok: false, error: err };
}

// oldest signature of an address (paginates up to 3 pages = 3000 txs)
export async function oldest(addr) {
  let before; let last = null;
  for (let page = 0; page < 3; page++) {
    const r = await rpc('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!r.ok) return last ? { ...last, partial: true } : { error: r.error };
    const arr = r.result || [];
    if (!arr.length) return last || { none: true };
    last = { sig: arr[arr.length - 1].signature, time: arr[arr.length - 1].blockTime || null, slot: arr[arr.length - 1].slot || null };
    if (arr.length < 1000) return last;
    before = last.sig;
  }
  return { ...last, busy: true }; // more than 3000 txs: this is not the first one
}

// ---------------------------------------------------------------- the scan
export async function scanMint(mint, { pairCreatedAt = null } = {}) {
  const C = BUNDLE_CFG;
  const raw = { at: Date.now(), ran: false, error: null, analysed: 0, wallets: [], note: [] };
  const deadline = Date.now() + C.budgetMs;
  try {
    const [sup, big] = await Promise.all([rpc('getTokenSupply', [mint]), rpc('getTokenLargestAccounts', [mint])]);
    if (!sup.ok || !big.ok) { raw.error = sup.error || big.error; return raw; }
    const supply = Number(sup.result?.value?.amount) || 0;
    const top = (big.result?.value || []).slice(0, 20);
    if (!supply || !top.length) { raw.error = 'no holder data'; return raw; }
    const ta = await rpc('getMultipleAccounts', [top.map((t) => t.address), { encoding: 'jsonParsed' }]);
    if (!ta.ok) { raw.error = ta.error; return raw; }
    const holders = top.map((t, i) => ({ tokenAccount: t.address, amount: Number(t.amount) || 0, pct: ((Number(t.amount) || 0) / supply) * 100, owner: ta.result?.value?.[i]?.data?.parsed?.info?.owner || null })).filter((h) => h.owner);
    const oa = await rpc('getMultipleAccounts', [holders.map((h) => h.owner), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    if (!oa.ok) { raw.error = oa.error; return raw; }
    // real wallets only: system-owned with a balance. Pool vaults / bonding curves / program PDAs are excluded.
    const wallets = holders.filter((h, i) => { const a = oa.result?.value?.[i]; return a && a.owner === SYSTEM_PROGRAM && a.lamports > 0; });
    const sample = wallets.slice(0, C.wallets);
    raw.walletsTotal = wallets.length;
    const pc = pairCreatedAt ? Math.floor(pairCreatedAt / 1000) : null;
    const work = async (h) => {
      const [t, w] = await Promise.all([oldest(h.tokenAccount), oldest(h.owner)]);
      h.buyTime = t && !t.busy && !t.error && !t.none ? t.time : null;
      h.walletFirst = w && !w.error && !w.none ? w.time : null;
      if (w && w.sig && !w.busy && !w.error && !w.none) {
        const tx = await rpc('getTransaction', [w.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        for (const ix of tx.result?.transaction?.message?.instructions || []) {
          if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === h.owner) { h.funder = ix.parsed.info.source; h.fundTime = w.time; break; }
        }
      }
      h.fresh = h.buyTime && h.walletFirst != null ? (h.buyTime - h.walletFirst) <= C.freshMin * 60 : null;
      h.launch = pc && h.buyTime ? (h.buyTime - pc) <= 60 : null;
      if (h.buyTime || h.funder) raw.analysed++;
    };
    let idx = 0;
    const runners = Array.from({ length: 3 }, async () => {
      while (idx < sample.length && Date.now() < deadline) await work(sample[idx++]);
    });
    await Promise.all(runners);
    if (idx < sample.length) raw.note.push(`time budget reached after ${idx}/${sample.length} wallets`);
    raw.wallets = sample.slice(0, idx).map((h) => ({ o: h.owner, pct: +h.pct.toFixed(3), amt: h.amount, buy: h.buyTime, fund: h.funder || null, fundT: h.fundTime || null, fresh: h.fresh, launch: h.launch }));
    raw.ran = true;
  } catch (e) { raw.error = e.message; }
  return raw;
}

// ---------------------------------------------------------------- pure classification (unit-testable, thresholds applied here)
export function classify(raw, opts = {}) {
  const C = { ...BUNDLE_CFG, ...opts };
  const out = { status: 'unknown', pct: 0, connected: 0, clusters: [], evidence: [], analysed: raw?.analysed || 0 };
  if (!raw?.ran) { out.status = 'unknown'; out.error = raw?.error || 'not scanned'; return out; }
  const ws = raw.wallets;
  const n = ws.length;
  const parent = ws.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const types = new Map(); // component root -> Set of signal types
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = ws[i], b = ws[j]; const t = new Set();
    if (a.fund && a.fund === b.fund) t.add('same funder');
    if (a.fundT && b.fundT && Math.abs(a.fundT - b.fundT) <= C.fundWindowS) t.add('funded together');
    if (a.buy && b.buy && Math.abs(a.buy - b.buy) <= C.launchWindowS) t.add('bought together');
    if (a.launch && b.launch) t.add('launch buyers');
    if (a.fresh && b.fresh) t.add('both burner wallets');
    if (a.amt > 0 && b.amt > 0 && Math.max(a.amt, b.amt) / Math.min(a.amt, b.amt) < 1.15) t.add('same size');
    const timing = t.has('funded together') || t.has('bought together') || t.has('launch buyers');
    if (t.size >= 2 && timing) edges.push([i, j, t]); // two DIFFERENT signals, at least one of them about timing (size / funder alone prove nothing)
  }
  for (const [i, j] of edges) parent[find(i)] = find(j);
  for (const [i, , t] of edges) { const r = find(i); if (!types.has(r)) types.set(r, new Set()); t.forEach((x) => types.get(r).add(x)); }
  const comps = new Map();
  for (const [i] of edges) { const r = find(i); if (!comps.has(r)) comps.set(r, new Set()); comps.get(r).add(i); }
  for (const [i, j] of edges) { comps.get(find(i)).add(j); }
  for (const [r, set] of comps) {
    const members = [...set].map((k) => ws[k]);
    const pct = members.reduce((a, w) => a + w.pct, 0);
    const sig = [...types.get(r)];
    out.clusters.push({ size: members.length, pct: +pct.toFixed(2), signals: sig, wallets: members.map((w) => w.o) });
    out.evidence.push(`${members.length} linked wallets hold ${pct.toFixed(1)}% [${sig.join(', ')}]`);
  }
  out.clusters.sort((a, b) => b.pct - a.pct);
  out.pct = out.clusters[0]?.pct || 0;
  out.connected = out.clusters.reduce((a, c) => a + c.size, 0);
  const enough = out.analysed >= Math.min(5, Math.max(3, n));
  if (out.pct > C.maxClusterPct || out.connected >= C.maxConnected) out.status = 'bundled';
  else out.status = enough ? 'clean' : 'unknown';
  if (out.status === 'unknown') out.error = `only ${out.analysed} holder wallets could be traced`;
  return out;
}

// ---------------------------------------------------------------- cache + background queue
const results = new Map(); // mint -> { raw, res, at, tries }
const queue = new Map();   // mint -> { rank, prio, wanted, meta }
let running = 0, started = false, dirty = false;
const stats = { scanned: 0, bundled: 0, failed: 0 };
try { const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); for (const [k, v] of Object.entries(j)) if (Date.now() - v.at < 12 * 3600000) results.set(k, v); } catch { /* first run */ }
function persist() {
  if (!dirty) return; dirty = false;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); const o = {}; for (const [k, v] of results) o[k] = { at: v.at, tries: v.tries, raw: v.raw, res: { status: v.res.status, pct: v.res.pct, connected: v.res.connected, evidence: v.res.evidence.slice(0, 3), analysed: v.res.analysed, error: v.res.error } }; fs.writeFileSync(CACHE_FILE, JSON.stringify(o)); } catch { /* ignore */ }
}
setInterval(persist, 30000).unref();

const ttlOf = (v) => (v.res.status === 'bundled' ? BUNDLE_CFG.badTtlMin : v.res.status === 'clean' ? BUNDLE_CFG.okTtlMin : BUNDLE_CFG.retryMin) * 60000;
export function bundleState(mint) {
  const v = results.get(mint);
  if (!v) return { status: queue.has(mint) ? 'pending' : 'unqueued' };
  const stale = Date.now() - v.at > ttlOf(v);
  return { status: v.res.status, pct: v.res.pct, connected: v.res.connected, evidence: v.res.evidence, error: v.res.error, stale, analysed: v.res.analysed };
}
// Ask for a coin to be scanned. Lower prio number = sooner; rank keeps list order. Cheap to call every feed cycle.
export function requestBundleScan(mint, { prio = 0, rank = 0, pairCreatedAt = null } = {}) {
  const v = results.get(mint);
  if (v && Date.now() - v.at < ttlOf(v)) return;
  const q = queue.get(mint);
  queue.set(mint, { prio, rank, pairCreatedAt, wanted: Date.now(), queuedAt: q?.queuedAt || Date.now() });
  if (!started) { started = true; setInterval(pump, 1500).unref(); }
}
async function pump() {
  // forget coins the feed stopped asking for
  for (const [m, q] of queue) if (Date.now() - q.wanted > 5 * 60000) queue.delete(m);
  while (running < BUNDLE_CFG.concurrency && queue.size) {
    const [mint, q] = [...queue.entries()].sort((a, b) => a[1].prio - b[1].prio || a[1].rank - b[1].rank || a[1].queuedAt - b[1].queuedAt)[0];
    queue.delete(mint);
    running++;
    (async () => {
      try {
        const raw = await scanMint(mint, { pairCreatedAt: q.pairCreatedAt });
        const res = classify(raw);
        const prev = results.get(mint);
        results.set(mint, { at: Date.now(), tries: (prev?.tries || 0) + 1, raw, res });
        dirty = true;
        if (res.status === 'bundled') stats.bundled++; else if (res.status === 'unknown') stats.failed++;
        stats.scanned++;
      } catch { /* retry on next request */ } finally { running--; }
    })();
  }
}
export const bundleStats = () => ({ ...stats, queued: queue.size, running, cached: results.size });
export const bundleFull = (mint) => results.get(mint) || null;
