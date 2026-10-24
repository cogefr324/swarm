// Token identity + scam verification. Runs BEFORE the bot is allowed to buy anything.
//
// Question it answers: "is this mint the real, dominant token for its ticker, and is it safe enough?"
//   1. DexScreener  - every Solana pair for the ticker, grouped by mint, scored (liquidity, volume, txns,
//                     buyers, age, markets). The target must be the strongest candidate, not a copycat.
//   2. RugCheck     - risk report for that mint (critical flags, holder concentration, creator share, LP).
//   3. Solana RPC   - mint/freeze authority, token-2022 danger extensions, metadata (and mutability), token
//                     age, recent pool activity - read straight from chain.
//   4. Cross-check  - name / symbol / logo / website / socials must not conflict between DexScreener,
//                     RugCheck and on-chain metadata.
// Only free, keyless APIs are used (DexScreener, RugCheck, GeckoTerminal for unique-buyer counts, free public
// Solana RPCs, or a Helius FREE-tier key if you set HELIUS_API_KEY). No Birdeye, no paid plans.
//
// Output: { decision: 'buy_allowed' | 'buy_blocked', reasons[], warnings[], ... } - see verify().

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { conyrSummary, conyrEnabled } from './conyr.js';
import { scanMint, classify, bundleFull } from './onchain-bundle.js';
import { HOLDER_FILTER, reportVerdict, refreshBubbles, bubbleOf, bubbleEnabled } from './bubblemaps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// ------------------------------------------------------------------ config
// Defaults < server/data/verify-config.json < environment variables (VERIFY_MIN_LIQUIDITY_USD=30000 ...)
export const DEFAULTS = {
  mode: 'enforce',                 // 'enforce' = block bad coins; 'dry-run' = decide + log, but never block
  min_liquidity_usd: 25000,
  min_pair_age_min: 30,
  min_unique_buyers: 100,          // 24h unique buyers (GeckoTerminal); falls back to the buy-count proxy
  reject_mint_authority: true,
  reject_freeze_authority: true,
  reject_mutable_metadata: true,
  max_top10_pct: 45,               // % of supply, liquidity pools / bonding curve excluded
  max_creator_pct: 10,             // % of supply held by the creator wallet
  min_liq_ratio_vs_leader: 0.2,    // target liquidity must be at least this share of the leading candidate
  require_lp_burned: true,         // liquidity pool tokens must be 100% burned / locked
  lp_burned_min_pct: 99.9,
  max_rugcheck_score: 50,          // RugCheck normalised score, higher = riskier
  rugcheck_ignore_danger: [],      // names of RugCheck "danger" flags you choose to tolerate
  require_metadata_match: true,
  max_recent_activity_min: 30,     // the main pool must have traded within this many minutes
  decision_cache_ms: 60000,
  final_cache_ms: 600000,          // permanent rejections are cached this long
  http_timeout_ms: 8000,
  http_retries: 2,
  // hidden-bundle / wallet-cluster layer
  bundle_check: true,
  bundle_review_pct: 10,           // Conyr bundled_supply_pct above this -> manual_review_required (not bought)
  bundle_block_pct: 15,            // above this -> buy_blocked_bundled_supply
  bundle_strong_pct: 25,           // above this -> flagged "strong"
  cluster_max_pct: 12,             // one suspected cluster holding more than this % of supply -> blocked
  cluster_max_connected_top20: 8,  // this many of the top 20 holders connected -> blocked
  cluster_launch_window_s: 45,     // suspected wallets that all bought inside this window count as a timing signal
  cluster_fund_window_s: 120,      // ... funded inside this window
  cluster_wallets: 14,             // top holders investigated by the RPC heuristic (keeps free RPC usage small)
  cluster_budget_ms: 25000,
  bundle_fail_open: false,         // true = allow the buy when neither Conyr nor the RPC heuristic could run
};
const NUMERIC = new Set(Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'number'));
const BOOL = new Set(Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean'));

export function loadConfig() {
  const cfg = { ...DEFAULTS };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'verify-config.json'), 'utf8'))); } catch { /* optional file */ }
  for (const k of Object.keys(DEFAULTS)) {
    const v = process.env[`VERIFY_${k.toUpperCase()}`];
    if (v == null || v === '') continue;
    if (NUMERIC.has(k)) { const n = Number(v); if (Number.isFinite(n)) cfg[k] = n; }
    else if (BOOL.has(k)) cfg[k] = /^(1|true|yes|on)$/i.test(v);
    else if (k === 'rugcheck_ignore_danger') cfg[k] = v.split(',').map((x) => x.trim()).filter(Boolean);
    else cfg[k] = v;
  }
  return cfg;
}

// ------------------------------------------------------------------ http (timeouts, retries, rate limits)
const HOST_GAP_MS = { 'api.dexscreener.com': 250, 'api.rugcheck.xyz': 400, 'api.geckoterminal.com': 2200 };
const hostChain = new Map(); // host -> promise tail, so calls to one host are spaced out
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function schedule(host, fn) {
  const gap = HOST_GAP_MS[host] ?? 100;
  const prev = hostChain.get(host) || Promise.resolve();
  const run = prev.then(fn);
  hostChain.set(host, run.then(() => sleep(gap), () => sleep(gap)));
  return run;
}

async function httpJson(url, { method = 'GET', body, headers = {}, cfg } = {}) {
  const host = new URL(url).host;
  let last = { ok: false, status: 0, error: 'not attempted' };
  for (let attempt = 0; attempt <= cfg.http_retries; attempt++) {
    last = await schedule(host, async () => {
      try {
        const r = await fetch(url, {
          method,
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(cfg.http_timeout_ms),
        });
        if (r.status === 429 || r.status >= 500) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0, error: `HTTP ${r.status}` };
        if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}`, final: true };
        return { ok: true, status: r.status, data: await r.json() };
      } catch (e) {
        return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
      }
    });
    if (last.ok || last.final) return last;
    if (attempt < cfg.http_retries) await sleep(last.retryAfter ? last.retryAfter * 1000 : 700 * 2 ** attempt);
  }
  return last;
}

// ------------------------------------------------------------------ Solana RPC (free endpoints only)
function rpcEndpoints() {
  const list = [];
  if (process.env.SOLANA_RPC_URL) list.push(process.env.SOLANA_RPC_URL);
  if (process.env.HELIUS_API_KEY) list.push(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`); // free tier key
  list.push('https://solana.api.onfinality.io/public', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com');
  return list;
}
const rpcBlockedUntil = new Map();
async function rpc(method, params, cfg) {
  let lastErr = 'no RPC endpoint available';
  for (const url of rpcEndpoints()) {
    if (Date.now() < (rpcBlockedUntil.get(url) || 0)) continue;
    const r = await httpJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, cfg: { ...cfg, http_retries: 0 } });
    if (r.ok && r.data && !r.data.error) return { ok: true, result: r.data.result };
    lastErr = r.data?.error?.message || r.error || 'rpc error';
    if (r.status === 429 || r.status === 403 || r.status === 0 || r.status >= 500) rpcBlockedUntil.set(url, Date.now() + 20000);
  }
  return { ok: false, error: lastErr };
}

// ------------------------------------------------------------------ tiny base58 + PDA (so no extra dependency)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const P = 2n ** 255n - 19n;
const D = ((P - 121665n) * modpow(121666n, P - 2n, P)) % P;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
function onCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modpow(v, P - 2n, P)) % P;
  if (x2 === 0n) return true;
  return modpow(x2, (P - 1n) / 2n, P) === 1n;
}
function findPda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([...seeds, Buffer.from([bump]), programId, Buffer.from('ProgramDerivedAddress')])).digest();
    if (!onCurve(h)) return b58encode(h);
  }
  return null;
}
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export function metadataPda(mint) {
  const prog = b58decode(METAPLEX);
  return findPda([Buffer.from('metadata'), prog, b58decode(mint)], prog);
}
function parseMetaplexMetadata(buf) {
  try {
    let o = 1 + 32 + 32;
    const str = () => { const n = buf.readUInt32LE(o); o += 4; const s = buf.slice(o, o + n).toString('utf8').replace(/\0+$/g, '').trim(); o += n; return s; };
    const name = str(), symbol = str(), uri = str();
    o += 2; // seller fee
    if (buf[o++] === 1) { const n = buf.readUInt32LE(o); o += 4 + n * 34; } // creators
    o += 1; // primary sale
    const isMutable = buf[o] === 1;
    return { name, symbol, uri, isMutable, updateAuthority: b58encode(buf.slice(1, 33)) };
  } catch { return null; }
}

// ------------------------------------------------------------------ helpers
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pct = (n) => `${Number(n).toFixed(1)}%`;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const cidOf = (u) => /\/ipfs\/([A-Za-z0-9]+)/.exec(u || '')?.[1] || (/^ipfs:\/\/([A-Za-z0-9]+)/.exec(u || '')?.[1]) || null;
const handleOf = (u) => { const m = /(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(u || ''); return m ? m[1].toLowerCase() : null; };
const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const SOCIAL_IGNORE_HOSTS = new Set(['pump.fun', 'ipfs.io', 'twitter.com', 'x.com', 't.me', 'linktr.ee']);

// ------------------------------------------------------------------ 1. DexScreener candidates
async function dexCandidates(ticker, mint, cfg) {
  const pairs = new Map();
  const add = (list) => { for (const p of list || []) if (p.chainId === 'solana' && p.baseToken?.address && p.pairAddress) pairs.set(p.pairAddress, p); };
  const bySym = ticker ? await httpJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`, { cfg }) : { ok: false };
  if (bySym.ok) add((bySym.data?.pairs || []).filter((p) => norm(p.baseToken?.symbol) === norm(ticker)));
  // the search endpoint caps its results, so always fetch the target mint's own pairs too
  const byMint = await httpJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { cfg });
  if (byMint.ok) add(byMint.data?.pairs);
  if (!bySym.ok && !byMint.ok) return { ok: false, error: `DexScreener unavailable (${byMint.error || bySym.error})` };

  const groups = new Map();
  for (const p of pairs.values()) {
    const m = p.baseToken.address;
    if (ticker && norm(p.baseToken.symbol) !== norm(ticker)) continue;
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(p);
  }
  const now = Date.now();
  const cands = [...groups.entries()].map(([m, list]) => {
    const sum = (f) => list.reduce((s, p) => s + (f(p) || 0), 0);
    const created = list.map((p) => p.pairCreatedAt).filter(Boolean);
    const top = list.slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      mint: m,
      name: top.baseToken.name,
      symbol: top.baseToken.symbol,
      liquidityUsd: sum((p) => p.liquidity?.usd),
      volume24h: sum((p) => p.volume?.h24),
      txns24h: sum((p) => (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)),
      buys24h: sum((p) => p.txns?.h24?.buys),
      ageMin: created.length ? (now - Math.min(...created)) / 60000 : 0,
      markets: new Set(list.map((p) => p.dexId)).size + (list.length - new Set(list.map((p) => p.dexId)).size) * 0.5,
      pairCount: list.length,
      topPair: top.pairAddress,
      topDex: top.dexId,
      marketCap: top.marketCap || top.fdv || 0,
      info: top.info || null,
    };
  });
  // relative score: each metric as a share of the best candidate's value
  const mx = (k) => Math.max(...cands.map((c) => c[k]), 1e-9);
  const M = { liq: mx('liquidityUsd'), vol: mx('volume24h'), tx: mx('txns24h'), buy: mx('buys24h'), age: mx('ageMin'), mk: mx('markets') };
  for (const c of cands) {
    c.score = Number((0.35 * c.liquidityUsd / M.liq + 0.25 * c.volume24h / M.vol + 0.15 * c.txns24h / M.tx + 0.10 * c.buys24h / M.buy + 0.10 * c.ageMin / M.age + 0.05 * c.markets / M.mk).toFixed(4));
  }
  cands.sort((a, b) => b.score - a.score);
  return { ok: true, candidates: cands, partial: !bySym.ok ? 'ticker search failed - only the target mint was compared' : null };
}

// ------------------------------------------------------------------ 2. RugCheck
async function rugcheckReport(mint, cfg) {
  const r = await httpJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { cfg });
  if (!r.ok) return { ok: false, error: r.status === 404 ? 'RugCheck has no report for this mint yet' : `RugCheck ${r.error}` };
  return { ok: true, report: r.data };
}
function analyseRugcheck(rep, cand, cfg, out) {
  const risks = Array.isArray(rep.risks) ? rep.risks : [];
  const danger = risks.filter((x) => String(x.level).toLowerCase() === 'danger' && !cfg.rugcheck_ignore_danger.includes(x.name));
  const score = rep.score_normalised ?? null;
  const supply = Number(rep.token?.supply) || 0;
  const dec = Number(rep.token?.decimals) || 0;
  // holders that are really liquidity pools / bonding curves must not count as "whales"
  const pools = new Set();
  for (const m of rep.markets || []) for (const k of [m.pubkey, m.liquidityA, m.liquidityB, m.mintLP]) if (k) pools.add(k);
  pools.add(cand.topPair);
  const holders = (rep.topHolders || []).filter((h) => !pools.has(h.address) && !pools.has(h.owner) && !h.isPool);
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  const creator = rep.creator || null;
  let creatorPct = null;
  if (creator) {
    const h = (rep.topHolders || []).filter((x) => x.address === creator || x.owner === creator);
    creatorPct = h.reduce((s, x) => s + (Number(x.pct) || 0), 0);
    if (!h.length && supply > 0 && rep.creatorBalance != null) creatorPct = (Number(rep.creatorBalance) / 10 ** dec / (supply / 10 ** dec)) * 100;
  }
  // LP: pick the market that matches the main pair, else the deepest one
  const markets = rep.markets || [];
  const market = markets.find((m) => m.pubkey === cand.topPair) || markets.slice().sort((a, b) => ((b.lp?.lpTotalUSD ?? 0) - (a.lp?.lpTotalUSD ?? 0)))[0] || null;
  const type = String(market?.marketType || '').toLowerCase();
  const bondingCurve = (/pump_fun|pumpfun|bonding|moonshot|dbc|curve/.test(type) && !/amm|swap/.test(type)) || /pumpfun|moonshot|bonding/.test(String(cand.topDex).toLowerCase());
  const lpLockedPct = market?.lp?.lpLockedPct ?? null;
  const insiders = Number(rep.graphInsidersDetected) || 0;
  Object.assign(out.rugcheck, {
    score, rugged: !!rep.rugged, dangerFlags: danger.map((x) => x.name), allFlags: risks.map((x) => `${x.level}:${x.name}`),
    top10Pct: Number(top10.toFixed(1)), creatorPct: creatorPct == null ? null : Number(creatorPct.toFixed(2)),
    totalHolders: rep.totalHolders ?? null, insiderWallets: insiders,
    lpLockedPct, lpMarketType: market?.marketType || null, bondingCurve,
    meta: { name: rep.tokenMeta?.name || rep.fileMeta?.name || null, symbol: rep.tokenMeta?.symbol || rep.fileMeta?.symbol || null, uri: rep.tokenMeta?.uri || null, mutable: rep.tokenMeta?.mutable ?? null, image: rep.fileMeta?.image || null },
  });
  if (rep.rugged) out.reasons.push('RugCheck marks this token as RUGGED');
  if (danger.length) out.reasons.push(`RugCheck critical flags: ${danger.map((x) => x.name).join(', ')}`);
  if (score != null && score >= cfg.max_rugcheck_score) out.reasons.push(`RugCheck risk score ${Math.round(score)}/100 (max ${cfg.max_rugcheck_score})`);
  if (top10 > cfg.max_top10_pct) out.reasons.push(`top 10 holders own ${pct(top10)} of supply (max ${cfg.max_top10_pct}%, pools excluded)`);
  if (creatorPct != null && creatorPct > cfg.max_creator_pct) out.reasons.push(`creator wallet holds ${pct(creatorPct)} (max ${cfg.max_creator_pct}%)`);
  // LP must be 100% burned/locked. Bonding-curve coins have no removable LP, so the check does not apply to them.
  if (cfg.require_lp_burned) {
    if (bondingCurve) out.warnings.push('still on a bonding curve - liquidity is not a removable LP position');
    else if (lpLockedPct == null) { out.reasons.push('LP burn status unknown (RugCheck has no LP data for the main pool)'); out.retryable = true; }
    else if (lpLockedPct < cfg.lp_burned_min_pct) out.reasons.push(`LP only ${pct(lpLockedPct)} burned/locked (need ${cfg.lp_burned_min_pct}%)`);
  }
}

// ------------------------------------------------------------------ 3. on-chain (free RPC)
async function onchain(mint, cand, cfg, out) {
  const ch = out.rpc;
  const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }], cfg);
  if (!acc.ok || !acc.result?.value) { ch.error = acc.error || 'mint account not found'; out.reasons.push(`RPC: cannot read mint account (${ch.error})`); out.retryable = true; return; }
  const v = acc.result.value;
  const info = v.data?.parsed?.info;
  if (!info) { out.reasons.push('RPC: mint account is not a parsed SPL token mint'); return; }
  ch.program = v.owner;
  ch.mintAuthority = info.mintAuthority || null;
  ch.freezeAuthority = info.freezeAuthority || null;
  ch.supply = info.supply; ch.decimals = info.decimals;
  if (cfg.reject_mint_authority && ch.mintAuthority) out.reasons.push(`mint authority is still active (${ch.mintAuthority})`);
  if (cfg.reject_freeze_authority && ch.freezeAuthority) out.reasons.push(`freeze authority is still active (${ch.freezeAuthority})`);

  // Token-2022 extensions that let the issuer take or tax tokens
  let meta = null;
  const ext = Array.isArray(info.extensions) ? info.extensions : [];
  ch.extensions = ext.map((e) => e.extension);
  for (const e of ext) {
    const st = e.state || {};
    if (e.extension === 'permanentDelegate' && st.delegate) out.reasons.push('Token-2022 permanent delegate (issuer can move anyone\'s tokens)');
    if (e.extension === 'transferHook' && st.programId) out.reasons.push('Token-2022 transfer hook is set');
    if (e.extension === 'nonTransferable') out.reasons.push('Token-2022 non-transferable token');
    if (e.extension === 'defaultAccountState' && st.accountState === 'frozen') out.reasons.push('Token-2022 accounts are frozen by default');
    if (e.extension === 'transferFeeConfig') {
      const bps = Math.max(Number(st.newerTransferFee?.transferFeeBasisPoints) || 0, Number(st.olderTransferFee?.transferFeeBasisPoints) || 0);
      if (bps > 500) out.reasons.push(`Token-2022 transfer fee is ${bps / 100}%`);
    }
    if (e.extension === 'tokenMetadata') meta = { name: st.name, symbol: st.symbol, uri: st.uri, isMutable: !!st.updateAuthority, updateAuthority: st.updateAuthority || null };
  }
  // legacy tokens: Metaplex metadata account
  if (!meta) {
    let pda = null;
    try { pda = metadataPda(mint); } catch { /* invalid mint string */ }
    const m = pda ? await rpc('getAccountInfo', [pda, { encoding: 'base64' }], cfg) : { ok: false };
    const b64 = m.ok ? m.result?.value?.data?.[0] : null;
    if (b64) meta = parseMetaplexMetadata(Buffer.from(b64, 'base64'));
  }
  ch.metadata = meta;
  if (!meta) { out.warnings.push('on-chain metadata not found / unreadable'); }
  else if (cfg.reject_mutable_metadata && meta.isMutable) out.reasons.push('token metadata is still mutable (name/image/uri can be changed by the update authority)');

  // token age: oldest transaction touching the mint (3 pages max); pool activity: newest transactions on the main pool
  let oldest = null, before, pages = 0, more = false;
  while (pages < 3) {
    const sig = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }], cfg);
    if (!sig.ok) { ch.ageError = sig.error; break; }
    const list = sig.result || [];
    if (!list.length) break;
    const last = list[list.length - 1];
    oldest = last.blockTime || oldest;
    pages++;
    if (list.length < 1000) { more = false; break; }
    before = last.signature; more = true;
  }
  if (oldest) { ch.tokenAgeMin = Math.round((Date.now() / 1000 - oldest) / 60); ch.tokenAgeIsLowerBound = more; }
  const pool = await rpc('getSignaturesForAddress', [cand.topPair, { limit: 100 }], cfg);
  if (pool.ok && pool.result?.length) {
    const newest = pool.result[0].blockTime;
    ch.lastPoolTxMinAgo = newest ? Math.round((Date.now() / 1000 - newest) / 60) : null;
    ch.poolTxInLast100 = pool.result.length;
    if (ch.lastPoolTxMinAgo != null && ch.lastPoolTxMinAgo > cfg.max_recent_activity_min) out.reasons.push(`main pool has no trades for ${ch.lastPoolTxMinAgo} min (needs one within ${cfg.max_recent_activity_min})`);
  } else if (pool.ok) out.warnings.push('no recent transactions found on the main pool');
  else out.warnings.push(`pool activity unavailable (${pool.error})`);
  if (ch.tokenAgeMin != null && ch.tokenAgeMin < cfg.min_pair_age_min) { out.reasons.push(`token only ${ch.tokenAgeMin} min old on-chain (min ${cfg.min_pair_age_min})`); out.retryable = true; }
}

// ------------------------------------------------------------------ 4. unique buyers (GeckoTerminal, free)
async function uniqueBuyers(cand, cfg) {
  const r = await httpJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${cand.topPair}`, { cfg });
  const t = r.ok ? r.data?.data?.attributes?.transactions?.h24 : null;
  if (t && t.buyers != null) return { value: Number(t.buyers), source: 'GeckoTerminal 24h unique buyers' };
  return { value: cand.buys24h, source: 'DexScreener 24h buy count (proxy - DexScreener has no unique-buyer figure)' };
}

// ------------------------------------------------------------------ 5. metadata / socials consistency
async function fetchOffchain(uri, cfg) {
  if (!uri) return null;
  const urls = [];
  const cid = /ipfs\/(.+)$/.exec(uri)?.[1] || /^ipfs:\/\/(.+)$/.exec(uri)?.[1];
  if (cid) urls.push(`https://ipfs.io/ipfs/${cid}`, `https://gateway.pinata.cloud/ipfs/${cid}`, `https://cloudflare-ipfs.com/ipfs/${cid}`);
  else if (/^https?:/i.test(uri)) urls.push(uri);
  for (const u of urls.slice(0, 2)) {
    const r = await httpJson(u, { cfg: { ...cfg, http_retries: 0 } });
    if (r.ok && r.data && typeof r.data === 'object') return r.data;
  }
  return null;
}
async function consistency(cand, out, cfg) {
  const dex = { name: cand.name, symbol: cand.symbol, image: cand.info?.imageUrl || null, websites: (cand.info?.websites || []).map((w) => w.url), socials: (cand.info?.socials || []).map((s) => s.url) };
  const rc = out.rugcheck.meta || {};
  const chain = out.rpc.metadata || {};
  const off = await fetchOffchain(chain.uri || rc.uri, cfg);
  const sources = {
    dexscreener: { name: dex.name, symbol: dex.symbol },
    rugcheck: { name: rc.name, symbol: rc.symbol },
    onchain: { name: chain.name, symbol: chain.symbol },
  };
  const conflicts = [];
  const compare = (field) => {
    const vals = Object.entries(sources).map(([k, v]) => [k, v[field]]).filter(([, v]) => v);
    for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
      const a = norm(vals[i][1]), b = norm(vals[j][1]);
      const ok = a === b || (field === 'name' && (a.includes(b) || b.includes(a)));
      if (!ok) conflicts.push(`${field} differs: ${vals[i][0]}="${vals[i][1]}" vs ${vals[j][0]}="${vals[j][1]}"`);
    }
  };
  compare('symbol'); compare('name');
  // logo: only comparable when both are IPFS (same CID) - different hosts can't be compared byte for byte
  const imgs = [dex.image, rc.image, off?.image].map(cidOf).filter(Boolean);
  if (imgs.length >= 2 && new Set(imgs).size > 1) conflicts.push('logo differs between sources (different IPFS images)');
  // socials / website
  const offSocial = [off?.twitter, off?.website, ...(Array.isArray(off?.extensions) ? Object.values(off.extensions) : [])].filter((x) => typeof x === 'string');
  const dexHandles = new Set([...dex.socials, ...dex.websites].map(handleOf).filter(Boolean));
  const offHandles = new Set(offSocial.map(handleOf).filter(Boolean));
  if (dexHandles.size && offHandles.size && ![...dexHandles].some((h) => offHandles.has(h))) conflicts.push(`twitter differs: DexScreener @${[...dexHandles][0]} vs token metadata @${[...offHandles][0]}`);
  const dexHosts = new Set(dex.websites.map(hostOf).filter((h) => h && !SOCIAL_IGNORE_HOSTS.has(h)));
  const offHosts = new Set(offSocial.map(hostOf).filter((h) => h && !SOCIAL_IGNORE_HOSTS.has(h)));
  if (dexHosts.size && offHosts.size && ![...dexHosts].some((h) => offHosts.has(h))) conflicts.push(`website differs: DexScreener ${[...dexHosts][0]} vs token metadata ${[...offHosts][0]}`);
  out.metadata = { sources, logo: { dexscreener: dex.image, rugcheck: rc.image, offchain: off?.image || null }, websites: dex.websites, socials: dex.socials, offchainSocials: offSocial.slice(0, 6), conflicts, offchainLoaded: !!off };
  if (!off) out.warnings.push('off-chain metadata JSON could not be loaded (socials/website not cross-checked against metadata)');
  if (!dex.websites.length && !dex.socials.length) out.warnings.push('no website or social links listed on DexScreener');
  if (conflicts.length && cfg.require_metadata_match) out.reasons.push(`identity conflict: ${conflicts.join('; ')}`);
}

// ------------------------------------------------------------------ main

// ------------------------------------------------------------------ hidden-bundle detection (free sources only)
// The on-chain wallet-cluster scan lives in onchain-bundle.js (shared with the feed's background queue and its cache).
async function clusterCheck(mint, cfg, ageMin) {
  const cached = bundleFull(mint);
  const raw = cached && Date.now() - cached.at < 20 * 60000 && cached.raw?.ran ? cached.raw : await scanMint(mint, { pairCreatedAt: ageMin != null ? Date.now() - ageMin * 60000 : null });
  const r = classify(raw, { maxClusterPct: cfg.cluster_max_pct, maxConnected: cfg.cluster_max_connected_top20, launchWindowS: cfg.cluster_launch_window_s, fundWindowS: cfg.cluster_fund_window_s });
  return { ran: raw.ran && r.status !== 'unknown', error: r.error || raw.error || null, biggestClusterPct: r.pct, connectedTop20: r.connected, evidence: r.evidence, clusters: r.clusters, wallets: raw.wallets?.length || 0 };
}

// Final hidden-bundle decision: Conyr first, RPC heuristic as the fallback / second opinion.
async function bundleCheck(mint, cfg, out) {
  const b = { decision: 'buy_allowed', conyr: null, cluster: null, reason: null };
  out.bundle = b;
  if (!cfg.bundle_check) return;
  const cy = await conyrSummary(mint);
  if (cy.ok) b.conyr = cy.data;
  const pct = b.conyr?.bundledSupplyPct;
  if (pct != null && pct > cfg.bundle_block_pct) {
    b.decision = 'buy_blocked_bundled_supply';
    b.reason = `Conyr: ${pct.toFixed(1)}% of supply bundled${pct > cfg.bundle_strong_pct ? ' (STRONG)' : ''}, ${b.conyr.bundleCount} cluster(s), dominant type ${b.conyr.dominantType || '?'} (max ${cfg.bundle_block_pct}%)`;
    return;
  }
  // heuristic runs when Conyr is down, or as a second opinion when Conyr is borderline
  if (!b.conyr || pct > cfg.bundle_review_pct) {
    b.cluster = await clusterCheck(mint, cfg, out.selected?.ageMin);
    const c = b.cluster;
    if (c.ran && (c.biggestClusterPct > cfg.cluster_max_pct || c.connectedTop20 >= cfg.cluster_max_connected_top20)) {
      b.decision = 'buy_blocked_wallet_cluster';
      b.reason = `wallet cluster: ${c.biggestClusterPct.toFixed(1)}% of supply in one confirmed cluster, ${c.connectedTop20} connected top holders (${c.evidence.slice(0, 2).join('; ')})`;
      return;
    }
    if (!b.conyr && !c.ran) {
      b.decision = 'buy_blocked_insufficient_data';
      b.reason = `no bundle data: Conyr ${conyrEnabled() ? 'unavailable/rate-limited' : 'not configured (set CONYR_API_KEY)'} and RPC cluster analysis failed (${c.error || 'unknown'})`;
      return;
    }
  }
  if (pct != null && pct > cfg.bundle_review_pct) { b.decision = 'manual_review_required'; b.reason = `Conyr: ${pct.toFixed(1)}% bundled supply is between ${cfg.bundle_review_pct}% and ${cfg.bundle_block_pct}% and no cluster was confirmed - needs a human look`; }
}

const decisionCache = new Map(); // mint -> { at, ttl, result }

export async function verify({ mint, ticker, mode } = {}) {
  const cfg = loadConfig();
  if (mode === 'enforce' || mode === 'dry-run') cfg.mode = mode;
  const hit = decisionCache.get(mint);
  if (hit && Date.now() - hit.at < hit.ttl) return { ...hit.result, cached: true, mode: cfg.mode, enforced: cfg.mode === 'enforce' };

  const out = {
    decision: 'buy_blocked', mint, ticker: ticker || null, mode: cfg.mode, enforced: cfg.mode === 'enforce', retryable: false,
    reasons: [], warnings: [], candidates: [], selected: null, leader: null, rugcheck: {}, rpc: {}, metadata: null, uniqueBuyers: null, at: Date.now(),
  };
  const finish = () => {
    out.decision = out.reasons.length ? 'buy_blocked' : 'buy_allowed';
    out.bundle_decision = out.bundle?.decision || (out.reasons.length ? 'not_checked' : 'buy_allowed');
    out.enforced = cfg.mode === 'enforce';
    const permanent = out.decision === 'buy_blocked' && !out.retryable;
    decisionCache.set(mint, { at: Date.now(), ttl: permanent ? cfg.final_cache_ms : cfg.decision_cache_ms, result: out });
    logDecision(out);
    return out;
  };

  try {
    // 1. candidates
    const d = await dexCandidates(ticker, mint, cfg);
    if (!d.ok) { out.reasons.push(d.error); out.retryable = true; return finish(); }
    if (d.partial) out.warnings.push(d.partial);
    out.candidates = d.candidates.map((c, i) => ({ ...c, info: undefined, rank: i + 1, isSelected: c.mint === mint }));
    const target = d.candidates.find((c) => c.mint === mint);
    const leader = d.candidates[0];
    out.leader = leader ? { mint: leader.mint, liquidityUsd: leader.liquidityUsd, score: leader.score } : null;
    if (!target) { out.reasons.push('no DexScreener pair found for this mint'); out.retryable = true; return finish(); }
    out.ticker = out.ticker || target.symbol;
    out.selected = { mint, symbol: target.symbol, name: target.name, liquidityUsd: target.liquidityUsd, volume24h: target.volume24h, txns24h: target.txns24h, ageMin: Math.round(target.ageMin), markets: target.pairCount, score: target.score, topPair: target.topPair };

    if (leader.mint !== mint) {
      const ratio = leader.liquidityUsd > 0 ? target.liquidityUsd / leader.liquidityUsd : 0;
      out.reasons.push(ratio < cfg.min_liq_ratio_vs_leader
        ? `copycat: liquidity is ${pct(ratio * 100)} of the leading ${out.ticker} token ${leader.mint} (min ${cfg.min_liq_ratio_vs_leader * 100}%)`
        : `not the dominant ${out.ticker} token - ${leader.mint} scores higher (${leader.score} vs ${target.score})`);
    }
    if (target.liquidityUsd < cfg.min_liquidity_usd) out.reasons.push(`liquidity ${usd(target.liquidityUsd)} is below the ${usd(cfg.min_liquidity_usd)} minimum`);
    if (target.ageMin < cfg.min_pair_age_min) { out.reasons.push(`pair is only ${Math.round(target.ageMin)} min old (min ${cfg.min_pair_age_min})`); out.retryable = true; }

    // 2. RugCheck (fail closed if unavailable)
    const rc = await rugcheckReport(mint, cfg);
    if (!rc.ok) { out.reasons.push(rc.error); out.retryable = true; out.rugcheck = { error: rc.error }; }
    else {
      analyseRugcheck(rc.report, target, cfg, out);
      const hv = HOLDER_FILTER ? reportVerdict(rc.report) : null;
      if (hv?.bad) out.reasons.push(`holder concentration: ${hv.bad}`);
    }

    // 2b. Bubblemaps clusters/bundles (only when BUBBLEMAPS_API_KEY is set; fails open if it is down/out of credits)
    if (bubbleEnabled()) {
      await refreshBubbles([mint]);
      const b = bubbleOf(mint);
      if (b) out.bubblemaps = b;
      if (b?.bad) out.reasons.push(`Bubblemaps: ${b.bad}`);
      else if (!b) out.warnings.push('Bubblemaps data unavailable (credits/rate limit) - skipped');
    }

    // 3. unique buyers
    out.uniqueBuyers = await uniqueBuyers(target, cfg);
    if (out.uniqueBuyers.value < cfg.min_unique_buyers) out.reasons.push(`only ${out.uniqueBuyers.value} unique buyers in 24h (min ${cfg.min_unique_buyers})`);

    // 4. on-chain
    await onchain(mint, target, cfg, out);

    // 5. cross-check identity across sources
    await consistency(target, out, cfg);

    // 2c. hidden bundles / wallet clusters (only if everything cheaper still passes - the RPC heuristic is the costly part)
    if (!out.reasons.length) {
      await bundleCheck(mint, cfg, out);
      const bd = out.bundle;
      if (bd.decision === 'buy_allowed') { /* ok */ }
      else if (bd.decision === 'buy_blocked_insufficient_data' && cfg.bundle_fail_open) out.warnings.push(bd.reason + ' - allowed (bundle_fail_open)');
      else { out.reasons.push(bd.reason); if (bd.decision === 'buy_blocked_insufficient_data') out.retryable = true; }
    }

    // a permanent red flag outranks "try again later"
    const permanentFlag = out.reasons.some((r) => /copycat|not the dominant|RUGGED|critical flags|authority|mutable|identity conflict|permanent delegate|creator wallet|Conyr|wallet cluster|top 10|LP only|Token-2022/.test(r));
    if (permanentFlag) out.retryable = false;
  } catch (e) {
    out.reasons.push(`verification error: ${e.message}`);
    out.retryable = true;
  }
  return finish();
}

// ------------------------------------------------------------------ logging
function logDecision(o) {
  const line = {
    t: new Date(o.at).toISOString(), ticker: o.ticker, mint: o.mint, decision: o.decision, mode: o.mode, reasons: o.reasons, warnings: o.warnings,
    candidates: o.candidates.map((c) => ({ mint: c.mint, liq: Math.round(c.liquidityUsd), vol24h: Math.round(c.volume24h), tx24h: c.txns24h, ageMin: Math.round(c.ageMin), markets: c.pairCount, score: c.score, selected: c.isSelected })),
    rugcheck: { score: o.rugcheck.score, rugged: o.rugcheck.rugged, danger: o.rugcheck.dangerFlags, top10Pct: o.rugcheck.top10Pct, creatorPct: o.rugcheck.creatorPct, lpLockedPct: o.rugcheck.lpLockedPct, error: o.rugcheck.error },
    rpc: { mintAuthority: o.rpc.mintAuthority, freezeAuthority: o.rpc.freezeAuthority, tokenAgeMin: o.rpc.tokenAgeMin, metadataMutable: o.rpc.metadata?.isMutable, lastPoolTxMinAgo: o.rpc.lastPoolTxMinAgo, error: o.rpc.error },
    bundle: o.bundle ? { decision: o.bundle.decision, reason: o.bundle.reason, conyr: o.bundle.conyr, cluster: o.bundle.cluster && { ran: o.bundle.cluster.ran, error: o.bundle.cluster.error, biggestClusterPct: o.bundle.cluster.biggestClusterPct, connectedTop20: o.bundle.cluster.connectedTop20, evidence: o.bundle.cluster.evidence } } : null,
    uniqueBuyers: o.uniqueBuyers?.value, metadataConflicts: o.metadata?.conflicts,
  };
  console.log(`[verify] ${o.decision.toUpperCase()}${o.mode === 'dry-run' ? ' (dry-run)' : ''} ${o.ticker || '?'} ${o.mint}${o.reasons.length ? ' - ' + o.reasons.join(' | ') : ''}`);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(path.join(DATA_DIR, 'verify-log.jsonl'), JSON.stringify(line) + '\n'); } catch { /* ignore */ }
}

export function recentDecisions(limit = 50) {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'verify-log.jsonl'), 'utf8').trim().split('\n').slice(-limit);
    return lines.map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}
