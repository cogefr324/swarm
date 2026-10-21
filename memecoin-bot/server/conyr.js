// Conyr bundle summary (FREE tier: self-serve key, no card). GET https://api.conyr.ai/v1/token/{mint}/bundles/summary
// Auth: Authorization: Bearer <CONYR_API_KEY> (key in server/.env). Free REST limit ~10 requests/min, so every call goes
// through one queue (default 8/min), results are cached, and 429s back off exponentially.
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const CONYR_CFG = {
  key: env.CONYR_API_KEY || '',
  base: env.CONYR_BASE_URL || 'https://api.conyr.ai',
  perMin: num('CONYR_PER_MIN', 8),
  ttlMs: num('CONYR_TTL_MIN', 20) * 60000,
  feedMaxPct: num('CONYR_FEED_MAX_PCT', 25), // coins above this are hidden from Top/Trending/New
  timeoutMs: 8000,
};
export const conyrEnabled = () => !!CONYR_CFG.key;

const cache = new Map(); // mint -> { at, v }  v = normalised summary | { none:true }
const inflight = new Map();
let nextSlot = 0; // queue: calls are spaced 60s/perMin apart
let backoffUntil = 0, backoffStep = 0, lastErr = null, calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const conyrStatus = () => ({ enabled: conyrEnabled(), cached: cache.size, calls, backoffSec: Math.max(0, Math.round((backoffUntil - Date.now()) / 1000)), lastError: lastErr });

export function normalise(j) {
  if (!j || typeof j !== 'object') return null;
  const d = j.data && typeof j.data === 'object' ? j.data : j;
  const pct = Number(d.bundled_supply_pct);
  if (!Number.isFinite(pct)) return null;
  return {
    source: 'conyr', bundledSupplyPct: pct, bundleCount: Number(d.bundle_count) || 0, openBundleCount: Number(d.open_bundle_count) || 0,
    bundledValueUsd: Number(d.bundled_value_usd) || 0, realizedPnlUsd: Number(d.bundled_realized_pnl_usd) || 0, dominantType: d.dominant_bundle_type || null,
  };
}

// One mint. Resolves { ok, data } | { ok:false, reason: 'no_key'|'rate_limited'|'unavailable'|'none' }. Never throws.
export async function conyrSummary(mint, { maxWaitMs = 20000, force = false } = {}) {
  if (!conyrEnabled()) return { ok: false, reason: 'no_key' };
  const hit = cache.get(mint);
  if (hit && !force && Date.now() - hit.at < CONYR_CFG.ttlMs) return hit.v.none ? { ok: false, reason: 'none', cached: true } : { ok: true, data: hit.v, cached: true };
  if (inflight.has(mint)) return inflight.get(mint);
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const gap = 60000 / Math.max(1, CONYR_CFG.perMin);
      const slot = Math.max(Date.now(), nextSlot, backoffUntil); nextSlot = slot + gap;
      const wait = slot - Date.now();
      if (wait > maxWaitMs) { nextSlot -= gap; return hit && !hit.v.none ? { ok: true, data: hit.v, stale: true } : { ok: false, reason: 'rate_limited' }; }
      if (wait > 0) await sleep(wait);
      try {
        calls++;
        const r = await fetch(`${CONYR_CFG.base}/v1/token/${mint}/bundles/summary`, { headers: { accept: 'application/json', Authorization: `Bearer ${CONYR_CFG.key}` }, signal: AbortSignal.timeout(CONYR_CFG.timeoutMs) });
        if (r.status === 429) { backoffStep = Math.min(backoffStep + 1, 6); const ra = Number(r.headers.get('retry-after')) || 0; backoffUntil = Date.now() + Math.max(ra * 1000, 5000 * 2 ** backoffStep); lastErr = 'HTTP 429 (rate limit) - backing off'; continue; }
        if (r.status === 401 || r.status === 403) { lastErr = `HTTP ${r.status} - check CONYR_API_KEY`; backoffUntil = Date.now() + 600000; return { ok: false, reason: 'unavailable' }; }
        if (r.status === 404) { cache.set(mint, { at: Date.now(), v: { none: true } }); return { ok: false, reason: 'none' }; }
        if (!r.ok) { lastErr = `HTTP ${r.status}`; await sleep(500 * 2 ** attempt); continue; }
        const v = normalise(await r.json());
        if (!v) { lastErr = 'unexpected response shape'; return { ok: false, reason: 'unavailable' }; }
        backoffStep = 0; lastErr = null;
        cache.set(mint, { at: Date.now(), v });
        return { ok: true, data: v };
      } catch (e) { lastErr = e.name === 'TimeoutError' ? 'timeout' : e.message; await sleep(500 * 2 ** attempt); }
    }
    return hit && !hit.v.none ? { ok: true, data: hit.v, stale: true } : { ok: false, reason: 'unavailable' };
  })().finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}

// Feed use: fill a few coins per refresh in priority order; never blocks long.
export async function conyrRefresh(mints, perCycle = 1) {
  if (!conyrEnabled() || Date.now() < backoffUntil) return;
  const need = mints.filter((m) => { const h = cache.get(m); return !h || Date.now() - h.at > CONYR_CFG.ttlMs; }).slice(0, perCycle);
  await Promise.all(need.map((m) => conyrSummary(m, { maxWaitMs: 1500 })));
}
export const conyrOf = (mint) => { const v = cache.get(mint)?.v; return v && !v.none ? v : null; };
export const conyrFeedBlock = (mint) => { const c = conyrOf(mint); return c && c.bundledSupplyPct > CONYR_CFG.feedMaxPct ? `bundled ${c.bundledSupplyPct.toFixed(0)}% (conyr)` : null; };
