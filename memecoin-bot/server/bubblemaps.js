// Holder-cluster / bundle analysis for the feed filter - catches "obvious rugs" that pass the
// mint / freeze / LP checks (one entity secretly holding most of the supply across many wallets).
//
// Two sources, both optional and both cached hard:
//  1) Bubblemaps Data API (https://docs.bubblemaps.io). NEEDS an API key (BUBBLEMAPS_API_KEY in server/.env,
//     sent as the X-ApiKey header). It is credit-based: ~25 credits per metrics call. No free tier is documented,
//     so this is OFF until you set a key. We keep a daily credit budget so it can never burn through your plan.
//  2) RugCheck full report (free, keyless) - insider networks + holder concentration. Always on as the fallback
//     (and as a second opinion when Bubblemaps is on).
import { conyrFeedBlock } from './conyr.js';
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' && !Number.isNaN(Number(env[k])) ? Number(env[k]) : d);

export const BUBBLE_CFG = {
  key: env.BUBBLEMAPS_API_KEY || '',
  base: env.BUBBLEMAPS_BASE_URL || 'https://api.bubblemaps.io',
  useMap: env.BUBBLEMAPS_USE_MAP !== '0', // also pull the bubble-map clusters (the graph view) - doubles the cost per coin
  creditsPerCall: num('BUBBLEMAPS_CREDITS_PER_CALL', 25),
  dailyCredits: num('BUBBLEMAPS_DAILY_CREDITS', 2500), // ~100 coin checks/day by default; raise to fit your plan
  perCycle: num('BUBBLEMAPS_PER_CYCLE', 3),
  ttlMs: num('BUBBLEMAPS_TTL_MIN', 60) * 60000,
  // thresholds (fractions of supply, 0-1)
  maxBundles: num('BUBBLE_MAX_BUNDLES', 0.20),
  maxTop10: num('BUBBLE_MAX_TOP10', 0.60),
  maxFresh: num('BUBBLE_MAX_FRESH', 0.40),
  maxCluster: num('BUBBLE_MAX_CLUSTER', 0.25),
  minScore: num('BUBBLE_MIN_SCORE', 0), // 0 = ignore bubblemaps_score (it is often null for new coins)
  // free fallback (RugCheck)
  maxInsiderPct: num('RC_MAX_INSIDER_PCT', 50),
  maxTop10Pct: num('RC_MAX_TOP10_PCT', 70),
  rcPerCycle: num('RC_FULL_PER_CYCLE', 6),
};
export const bubbleEnabled = () => !!BUBBLE_CFG.key;

const cache = new Map(); // mint -> { at, v }
let day = new Date().toISOString().slice(0, 10);
let spent = 0;
let blockedUntil = 0; // set on 401/402/429
let lastErr = null;
const spend = () => {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; spent = 0; }
  return spent;
};
export function bubbleStatus() {
  spend();
  return { enabled: bubbleEnabled(), creditsSpentToday: spent, dailyBudget: BUBBLE_CFG.dailyCredits, cached: cache.size, blocked: Date.now() < blockedUntil, lastError: lastErr };
}

const frac = (x) => { const n = Number(x); if (!Number.isFinite(n)) return null; return n > 1 ? n / 100 : n; };

// Pure: turn a Bubblemaps metrics (+ optional map) response into a verdict. Exported for tests.
export function bubbleVerdict(m, cfg = BUBBLE_CFG) {
  const s = m?.supply_stats || {};
  const sc = m?.scores || {};
  const bundles = frac(s.bundles), top10 = frac(s.top_10_adjusted), fresh = frac(s.fresh_wallets);
  const clusters = Array.isArray(m?.clusters) ? m.clusters : [];
  const topCluster = clusters.reduce((mx, c) => Math.max(mx, frac(c?.share) ?? 0), 0);
  const score = sc.bubblemaps_score == null ? null : Number(sc.bubblemaps_score);
  const info = { bundles, top10, fresh, topCluster: clusters.length ? topCluster : null, score, nakamoto: sc.nakamoto_coefficient ?? null };
  let bad = null;
  if (bundles != null && bundles > cfg.maxBundles) bad = `bundled ${(bundles * 100).toFixed(0)}%`;
  else if (clusters.length && topCluster > cfg.maxCluster) bad = `cluster ${(topCluster * 100).toFixed(0)}%`;
  else if (top10 != null && top10 > cfg.maxTop10) bad = `top10 ${(top10 * 100).toFixed(0)}%`;
  else if (fresh != null && fresh > cfg.maxFresh) bad = `fresh wallets ${(fresh * 100).toFixed(0)}%`;
  else if (cfg.minScore > 0 && score != null && score < cfg.minScore) bad = `bubblemaps score ${score}`;
  return { source: 'bubblemaps', bad, ...info };
}

async function callBubble(mint) {
  const url = `${BUBBLE_CFG.base}/v0/tokens/metrics/solana/${mint}`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'X-ApiKey': BUBBLE_CFG.key }, signal: AbortSignal.timeout(9000) });
  if (r.status === 401 || r.status === 403) { blockedUntil = Date.now() + 3600000; lastErr = `HTTP ${r.status} - check BUBBLEMAPS_API_KEY`; return { fatal: true }; }
  if (r.status === 402 || r.status === 429) { blockedUntil = Date.now() + 15 * 60000; lastErr = `HTTP ${r.status} - credits/rate limit hit, pausing 15 min`; return { fatal: true }; }
  if (r.status === 404 || r.status === 400 || r.status === 422) return { none: true }; // no holders / unsupported token
  if (!r.ok) { lastErr = `HTTP ${r.status}`; return { retry: true }; }
  spent += BUBBLE_CFG.creditsPerCall;
  const data = await r.json();
  if (BUBBLE_CFG.useMap) {
    try {
      const m = await fetch(`${BUBBLE_CFG.base}/v0/tokens/map/solana/${mint}`, { headers: { accept: 'application/json', 'X-ApiKey': BUBBLE_CFG.key }, signal: AbortSignal.timeout(12000) });
      if (m.ok) { spent += BUBBLE_CFG.creditsPerCall; data.clusters = (await m.json())?.clusters || []; }
      else if (m.status === 402 || m.status === 429) { blockedUntil = Date.now() + 15 * 60000; lastErr = `HTTP ${m.status} on map - pausing 15 min`; }
    } catch { /* metrics alone is still useful */ }
  }
  return { data };
}

// Fill in a few coins per cycle (priority order = order of `mints`), within the daily credit budget.
export async function refreshBubbles(mints) {
  if (!bubbleEnabled() || Date.now() < blockedUntil) return;
  spend();
  const need = mints.filter((m) => { const h = cache.get(m); return !h || Date.now() - h.at > BUBBLE_CFG.ttlMs; });
  let n = 0;
  for (const mint of need) {
    if (n >= BUBBLE_CFG.perCycle) break;
    if (spent + BUBBLE_CFG.creditsPerCall * (BUBBLE_CFG.useMap ? 2 : 1) > BUBBLE_CFG.dailyCredits) { lastErr = 'daily credit budget reached - raise BUBBLEMAPS_DAILY_CREDITS to check more coins'; break; }
    n++;
    try {
      const res = await callBubble(mint);
      if (res.fatal) break;
      if (res.retry) continue;
      cache.set(mint, { at: Date.now(), v: res.none ? { source: 'bubblemaps', bad: null, none: true } : bubbleVerdict(res.data) });
    } catch (e) { lastErr = e.message; }
  }
}
export const bubbleOf = (mint) => cache.get(mint)?.v || null;

// ---- Free fallback: RugCheck full report ----
const rcCache = new Map(); // mint -> { at, v }
export function reportVerdict(rep, cfg = BUBBLE_CFG) {
  if (!rep || typeof rep !== 'object') return null;
  const holders = Array.isArray(rep.topHolders) ? rep.topHolders : [];
  // topHolders[].pct is a percent of supply; drop liquidity-pool / AMM accounts so the pool is not counted as a whale
  const poolOwners = new Set((rep.markets || []).flatMap((m) => [m.liquidityA, m.liquidityB, m.pubkey, m.lp?.lpMint].filter(Boolean)));
  const real = holders.filter((h) => !h.isPool && !poolOwners.has(h.address) && !poolOwners.has(h.owner));
  const top10 = real.slice(0, 10).reduce((a, h) => a + (Number(h.pct) || 0), 0);
  const insiderPct = Number(rep.insiderHoldingPct ?? 0) || real.filter((h) => h.insider).reduce((a, h) => a + (Number(h.pct) || 0), 0);
  const nets = Array.isArray(rep.insiderNetworks) ? rep.insiderNetworks : [];
  const netTokens = nets.reduce((a, n) => a + (Number(n.tokenAmount) || 0), 0);
  const supply = Number(rep.token?.supply) || 0;
  const netPct = supply > 0 && netTokens > 0 ? (netTokens / supply) * 100 : 0;
  const worst = Math.max(insiderPct, netPct);
  let bad = null;
  if (worst > cfg.maxInsiderPct) bad = `insiders ${worst.toFixed(0)}%`;
  else if (real.length >= 5 && top10 > cfg.maxTop10Pct) bad = `top10 ${top10.toFixed(0)}%`;
  return { source: 'rugcheck-holders', bad, insiderPct: worst, top10, networks: nets.length };
}
export async function refreshReports(mints) {
  const need = mints.filter((m) => { const h = rcCache.get(m); return !h || Date.now() - h.at > 30 * 60000; }).slice(0, BUBBLE_CFG.rcPerCycle);
  await Promise.all(need.map(async (mint) => {
    try {
      const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: AbortSignal.timeout(9000) });
      if (r.status === 429) return;
      rcCache.set(mint, { at: Date.now(), v: r.ok ? reportVerdict(await r.json()) : null });
    } catch { /* next cycle */ }
  }));
}
export const reportOf = (mint) => rcCache.get(mint)?.v || null;

// The one question the feed asks: why (if at all) should this coin be hidden for holder concentration?
export function holderBlock(mint) {
  const cb = conyrFeedBlock(mint); if (cb) return cb;
  const b = bubbleOf(mint); if (b?.bad) return `bubblemaps: ${b.bad}`;
  const r = reportOf(mint); if (r?.bad) return `holders: ${r.bad}`;
  return null;
}
