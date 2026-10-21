// Early-gem finder. Modelled on SolBot Pro's scanner:
//   discover  -> many sources, de-duplicated, with an "already evaluated" cooldown
//   evaluate  -> DexScreener batch lookup (30 mints per call), best pair per coin by liquidity
//   filter    -> liquidity / market-cap window / 1h volume / 1h txns / age window / 1h move / buy-sell ratio
//   safety    -> mint + freeze authority revoked (on-chain), RugCheck not high-risk, Jupiter round-trip
//                quote (buy then sell) so honeypots and heavy-tax coins are skipped
// Smart-wallet and KOL tracking are still placeholders (need Helius webhooks / paid X API).

import { api } from './api';
import { summaryVerdict } from './rugAnalysis';
import { fetchRugCheckSummary } from './rugcheck';

// "Early" preset from SolBot - young pools with real short-term activity. Tune these numbers to taste.
export const GEM_CONFIG = {
  min_liquidity_usd: 5000,
  min_mc_usd: 8000,
  max_mc_usd: 600000,
  min_volume_h1_usd: 3000,
  min_txns_h1: 40,
  min_age_min: 1,
  max_age_min: 90,        // "fresh launch" window. Older coins can still qualify as a breakout (below)
  breakout_min_h1_change_pct: 40,   // an older coin must be running at least this much in the last hour...
  breakout_min_volume_h1_usd: 6000, // ...with at least this much 1h volume...
  breakout_min_txns_h1: 80,         // ...and this many trades
  min_h1_change_pct: 10,
  max_h1_change_pct: 800,
  min_buy_sell_ratio: 1.3,
  // Bundle / insider protection (RugCheck + Jupiter audit data)
  max_insider_pct: 15,       // skip if linked/insider wallets hold more than this % of supply
  max_dev_pct: 10,           // skip if the dev still holds more than this %
  max_insider_wallets: 25,   // skip if RugCheck links more than this many wallets together
  require_bundle_data: true, // no data yet = not bought yet (retried next scan)
  verify_enabled: true,      // token-identity + scam verification before any buy (server/verifier.js)
  verify_mode: 'enforce',    // 'enforce' | 'dry-run' (dry-run: decide + log, but never block). Set from Settings.
  require_no_mint_authority: true,
  require_no_freeze_authority: true,
  max_price_impact_pct: 5,
  min_roundtrip_ratio: 0.8,
  probe_sol: 0.1,        // size of the test buy/sell quotes
  slippage_bps: 2000,
  sell_slippage_bps: 3000,
  eval_cooldown_ms: 45000,
  max_per_scan: 90,
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const evalAt = new Map();       // mint -> last time it was evaluated
const rejectedForever = new Set(); // too old / unsafe: never look again this session
// Detected gems, newest first. Only good finds are recorded (skipped coins are not shown anywhere).
const GEM_LOG_KEY = 'gemDetectLog';
let gemLog = [];
try { gemLog = JSON.parse(localStorage.getItem(GEM_LOG_KEY) || '[]'); } catch { gemLog = []; }
export const getGemScanFeed = () => gemLog;
// Tiny health readout for the bot log (no per-coin skip lines): did the last scan actually run, and why nothing passed.
export const scanStats = { at: 0, candidates: 0, evaluated: 0, passedFilters: 0, blocked: 0, gems: 0, blockedWhy: {}, error: null };
const bump = (why) => { scanStats.blocked++; scanStats.blockedWhy[why] = (scanStats.blockedWhy[why] || 0) + 1; };

async function getJson(url, ms = 9000) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// ---------------------------------------------------------------- discovery
async function feedCandidates() {
  try {
    const f = await api.feed(); // our server: live Pump.fun launches + Gecko/Jupiter pools + coins that are moving right now
    const horizon = GEM_CONFIG.max_age_min * 60000 * 2;
    const fresh = (e) => e.pairCreatedAt && Date.now() - e.pairCreatedAt < horizon;
    const young = [...(f.newPairs || []), ...(f.finalStretch || [])].filter(fresh).sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);
    // movers/trending can be any age - an older coin that suddenly runs is exactly what we want to catch
    const running = [...(f.movers || []), ...(f.trending || [])];
    return [...young, ...running].map((e) => e.mint);
  } catch { return []; }
}
async function profileCandidates() {
  try {
    const d = await getJson('https://api.dexscreener.com/token-profiles/latest/v1');
    return (Array.isArray(d) ? d : []).filter((t) => t.chainId === 'solana').map((t) => t.tokenAddress);
  } catch { return []; }
}
async function boostedCandidates() {
  try {
    const d = await getJson('https://api.dexscreener.com/token-boosts/latest/v1');
    return (Array.isArray(d) ? d : []).filter((t) => t.chainId === 'solana').slice(0, 20).map((t) => t.tokenAddress);
  } catch { return []; }
}
async function smartWalletCandidates() { return []; } // placeholder - needs Helius webhook/websocket wallet tracking
async function kolCandidates() { return []; }         // placeholder - needs paid X API access

function bestPairs(data) {
  const best = new Map();
  for (const p of (data?.pairs || [])) {
    if (p.chainId !== 'solana' || !p.baseToken?.address) continue;
    const k = p.baseToken.address;
    if (!best.has(k) || (p.liquidity?.usd || 0) > (best.get(k).liquidity?.usd || 0)) best.set(k, p);
  }
  return [...best.values()];
}

async function discover(alerted) {
  const [fromFeed, profiles, boosted, smart, kol] = await Promise.all([
    feedCandidates(), profileCandidates(), boostedCandidates(), smartWalletCandidates(), kolCandidates(),
  ]);
  const boostedSet = new Set(boosted);
  const now = Date.now();
  const mints = [...new Set([...smart, ...kol, ...fromFeed, ...boosted, ...profiles])]
    .filter((m) => m && !alerted.has(m) && !rejectedForever.has(m) && now - (evalAt.get(m) || 0) > GEM_CONFIG.eval_cooldown_ms)
    .slice(0, GEM_CONFIG.max_per_scan);
  mints.forEach((m) => evalAt.set(m, now));
  const pairs = [];
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const data = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(',')}`);
      pairs.push(...bestPairs(data));
    } catch { /* next scan retries */ }
  }
  return { pairs, boostedSet, feedSet: new Set(fromFeed), candidateCount: mints.length };
}

// ---------------------------------------------------------------- filters
const pairMc = (p) => Number(p.marketCap || p.fdv || 0);
const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const BAD_NAME = /nigg|fagg|retard|hitler|nazi|kike|chink|spic\b|rape|raping|pedo|cp\b/i;
function passesFilters(p) {
  const C = GEM_CONFIG;
  const liq = p.liquidity?.usd || 0, vol = p.volume?.h1 || 0, h1 = p.priceChange?.h1 || 0, m5 = p.priceChange?.m5 || 0, mc = pairMc(p);
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : null;
  const tx = p.txns?.h1 || {}, buys = tx.buys || 0, sells = Math.max(tx.sells || 0, 1);
  const trades = buys + (tx.sells || 0);
  if (BAD_NAME.test(`${p.baseToken?.name || ''} ${p.baseToken?.symbol || ''}`)) return [false, 'offensive name'];
  if (age == null) return [false, 'no pair age'];
  if (age < C.min_age_min) return [false, `age ${age.toFixed(1)}m too young, rechecking`];
  const breakout = age > C.max_age_min; // older coin: only if it is clearly breaking out right now
  if (liq < C.min_liquidity_usd) return [false, `liq ${fmt(liq)} too low`];
  if (mc < C.min_mc_usd) return [false, `mc ${fmt(mc)} too low`];
  if (mc > C.max_mc_usd) return [false, `mc ${fmt(mc)} too high`];
  if (breakout) {
    if (h1 < C.breakout_min_h1_change_pct || h1 > C.max_h1_change_pct) return [false, `older coin, 1h change ${Math.round(h1)}%`];
    if (m5 < 0) return [false, 'older coin, already cooling off'];
    if (vol < C.breakout_min_volume_h1_usd) return [false, `older coin, 1h vol ${fmt(vol)} low`];
    if (trades < C.breakout_min_txns_h1) return [false, `older coin, only ${trades} trades`];
  } else {
    if (vol < C.min_volume_h1_usd) return [false, `1h vol ${fmt(vol)} low`];
    if (trades < C.min_txns_h1) return [false, `only ${trades} txns`];
    if (h1 < C.min_h1_change_pct || h1 > C.max_h1_change_pct) return [false, `1h change ${Math.round(h1)}%`];
  }
  if (buys / sells < C.min_buy_sell_ratio) return [false, `buy/sell ${buys}/${sells}`];
  return [true, breakout ? 'older coin breaking out' : 'passed filters'];
}

// ---------------------------------------------------------------- safety
async function mintSafe(mint) {
  try {
    const r = await api.mintInfo(mint);
    if (!r.ok) return r.retryable === false ? { ok: false, retryable: false, why: r.why || 'mint lookup failed' } : { ok: true, unchecked: true }; // RPC down: don't block every coin
    if (GEM_CONFIG.require_no_mint_authority && r.mintAuthority) return { ok: false, retryable: false, why: 'mint authority not revoked' };
    if (GEM_CONFIG.require_no_freeze_authority && r.freezeAuthority) return { ok: false, retryable: false, why: 'freeze authority not revoked' };
    return { ok: true };
  } catch (e) {
    return { ok: true, unchecked: true };
  }
}

async function rugCheckOk(mint) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: true, note: null }; // brand-new coins often aren't indexed yet - not a reason to skip
    const v = summaryVerdict(await r.json());
    if (v && (v.level === 'high' || v.level === 'rugged')) return { ok: false, why: `RugCheck ${v.level}${v.score != null ? ` (${Math.round(v.score)}/100)` : ''}` };
    return { ok: true, note: v?.score != null ? `RugCheck ${Math.round(v.score)}/100` : null };
  } catch { return { ok: true, note: null }; }
}

// Quote a buy and then a sell back, like SolBot's tryEnter: no sell route = honeypot, low round-trip = heavy tax.
async function quote(inMint, outMint, amount, slip) {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slip}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.status === 400 || r.status === 404) return { noRoute: true };
    if (!r.ok) return { unavailable: true };
    return { q: await r.json() };
  } catch { return { unavailable: true }; }
}
async function roundTrip(mint) {
  const C = GEM_CONFIG;
  const spend = Math.floor(C.probe_sol * 1e9);
  const b = await quote(SOL_MINT, mint, spend, C.slippage_bps);
  if (b.unavailable) return { ok: true, note: 'route check unavailable' };
  if (b.noRoute) return { ok: false, retryable: true, why: 'no buy route yet' };
  if (parseFloat(b.q.priceImpactPct || 0) * 100 > C.max_price_impact_pct) return { ok: false, retryable: true, why: 'price impact too high' };
  const s = await quote(mint, SOL_MINT, b.q.outAmount, C.sell_slippage_bps);
  if (s.unavailable) return { ok: true, note: 'sell route check unavailable' };
  if (s.noRoute) return { ok: false, retryable: false, why: 'no sell route (honeypot?)' };
  const ratio = Number(s.q.outAmount) / spend;
  if (ratio < C.min_roundtrip_ratio) return { ok: false, retryable: false, why: `round-trip ${ratio.toFixed(2)} (heavy tax / honeypot)` };
  return { ok: true, note: `round-trip ${ratio.toFixed(2)}` };
}

// Bundles / insiders: the gem finder used to buy coins where a handful of linked wallets held a huge share.
async function bundleOk(mint) {
  const C = GEM_CONFIG;
  let d = null;
  try { d = await fetchRugCheckSummary(mint, 20000); } catch { d = null; }
  if (!d || (d.insiderHoldingPct == null && d.devPct == null && d.insiderWallets == null)) {
    return C.require_bundle_data ? { ok: false, retryable: true, why: 'no bundle data yet' } : { ok: true, note: null };
  }
  const ins = Number(d.insiderHoldingPct) || 0, dev = Number(d.devPct) || 0, wallets = Number(d.insiderWallets) || 0;
  if (ins > C.max_insider_pct) return { ok: false, retryable: false, why: `bundled: insiders hold ${ins.toFixed(0)}%` };
  if (dev > C.max_dev_pct) return { ok: false, retryable: false, why: `dev holds ${dev.toFixed(0)}%` };
  if (wallets > C.max_insider_wallets) return { ok: false, retryable: false, why: `${wallets} linked wallets` };
  return { ok: true, note: `Bundles: insiders ${ins.toFixed(1)}%, dev ${dev.toFixed(1)}%${wallets ? `, ${wallets} linked wallets` : ''}` };
}

// Is this the REAL token for its ticker, and safe? Decided by the server (DexScreener + RugCheck + free RPC).
export const setGemVerifyMode = (m) => { GEM_CONFIG.verify_mode = m === 'dry-run' ? 'dry-run' : 'enforce'; };
async function identityOk(mint, ticker) {
  if (!GEM_CONFIG.verify_enabled) return { ok: true, note: null };
  try {
    const v = await api.verifyToken(mint, ticker, GEM_CONFIG.verify_mode);
    const allowed = v.decision === 'buy_allowed' || v.enforced === false;
    if (allowed) {
      const sel = v.selected;
      return { ok: true, note: v.decision === 'buy_allowed'
        ? `Verified real ${v.ticker}: top of ${v.candidates?.length || 1} same-ticker token(s), ${sel ? '$' + Math.round(sel.liquidityUsd).toLocaleString('en-US') + ' liquidity, ' : ''}LP burned/locked ${v.rugcheck?.bondingCurve ? 'n/a (bonding curve)' : (v.rugcheck?.lpLockedPct != null ? Math.round(v.rugcheck.lpLockedPct) + '%' : '?')}`
        : `DRY-RUN: filter would have blocked this (${(v.reasons || []).join('; ')})` };
    }
    return { ok: false, retryable: v.retryable !== false, why: (v.reasons || ['verification failed'])[0] };
  } catch (e) {
    return { ok: false, retryable: true, why: 'verification unavailable' }; // fail closed: no verdict, no buy
  }
}

// ---------------------------------------------------------------- main
// Only good finds are logged - skips are silent.
function logGem(pair, summary) {
  gemLog = [{ mint: pair.baseToken.address, sym: pair.baseToken.symbol, mc: pairMc(pair), status: 'gem', why: summary, at: Date.now() },
    ...gemLog.filter((f) => f.mint !== pair.baseToken.address)].slice(0, 100);
  try { localStorage.setItem(GEM_LOG_KEY, JSON.stringify(gemLog)); } catch { /* ignore */ }
}

export async function scanForEarlyGems(alreadyAlertedMints) {
  let found;
  scanStats.at = Date.now(); scanStats.evaluated = 0; scanStats.passedFilters = 0; scanStats.blocked = 0; scanStats.gems = 0; scanStats.blockedWhy = {}; scanStats.error = null;
  try { found = await discover(alreadyAlertedMints); } catch (e) { scanStats.error = e.message; return []; }
  scanStats.evaluated = found.pairs.length; scanStats.candidates = found.candidateCount || 0;
  const alerts = [];
  for (const pair of found.pairs) {
    const mint = pair.baseToken.address;
    const [ok, why] = passesFilters(pair);
    if (!ok) continue;
    scanStats.passedFilters++;

    const safe = await mintSafe(mint);
    if (!safe.ok) { bump(safe.why); if (!safe.retryable) rejectedForever.add(mint); continue; }
    const rug = await rugCheckOk(mint);
    if (!rug.ok) { bump(rug.why.replace(/ \(.*/, '')); rejectedForever.add(mint); continue; }
    const bd = await bundleOk(mint);
    if (!bd.ok) { bump(bd.why.replace(/ [\d.]+.*/, '').replace(/:.*/, '')); if (!bd.retryable) rejectedForever.add(mint); continue; }
    const idv = await identityOk(mint, pair.baseToken.symbol);
    if (!idv.ok) { bump(`verify: ${idv.why}`.replace(/\$?[\d,.]+%?.*/, '').replace(/[A-Za-z0-9]{32,}.*/, '').trim().slice(0, 60)); if (!idv.retryable) rejectedForever.add(mint); continue; }
    const rt = await roundTrip(mint);
    if (!rt.ok) { bump(rt.why.replace(/ [\d.]+.*/, '')); if (!rt.retryable) rejectedForever.add(mint); continue; }

    const liquidityUsd = pair.liquidity?.usd || 0;
    const tx1 = pair.txns?.h1 || { buys: 0, sells: 0 };
    const tx24 = pair.txns?.h24 || { buys: 0, sells: 0 };
    const ratio = tx1.sells > 0 ? tx1.buys / tx1.sells : Infinity;
    const ageMin = (Date.now() - pair.pairCreatedAt) / 60000;
    const mc = pairMc(pair);

    const reasons = [];
    if (found.feedSet.has(mint)) reasons.push('Picked up by the live market feed');
    if (found.boostedSet.has(mint)) reasons.push('Boosted on DexScreener right now');
    if (ageMin > GEM_CONFIG.max_age_min) reasons.push(`Older coin (${ageMin >= 1440 ? Math.round(ageMin / 1440) + ' days' : Math.round(ageMin / 60) + ' h'}) breaking out`);
    reasons.push(`${ageMin.toFixed(0)} min old, up ${Math.round(pair.priceChange?.h1 || 0)}% in the last hour`);
    reasons.push(`${fmt(pair.volume?.h1 || 0)} 1h volume, ${tx1.buys + tx1.sells} trades`);
    reasons.push(`Buy-heavy: ${tx1.buys} buys vs ${tx1.sells} sells (${ratio === Infinity ? '∞' : ratio.toFixed(1)}x)`);
    reasons.push(`${fmt(liquidityUsd)} liquidity, ${fmt(mc)} market cap`);
    reasons.push(safe.unchecked ? 'Authority check unavailable (RPC busy)' : 'Mint & freeze authority revoked');
    if (rt.note) reasons.push(`Sell-route test: ${rt.note}`);
    if (rug.note) reasons.push(rug.note);
    if (bd.note) reasons.push(bd.note);
    if (idv.note) reasons.push(idv.note);

    scanStats.gems++;
    logGem(pair, `${ageMin < 90 ? ageMin.toFixed(0) + 'm old' : 'breakout'}, +${Math.round(pair.priceChange?.h1 || 0)}% 1h, ${tx1.buys}/${tx1.sells} buys/sells, ${fmt(liquidityUsd)} liq`);
    alerts.push({
      mint,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      priceUsd: parseFloat(pair.priceUsd),
      liquidityUsd,
      volume24h: pair.volume?.h24 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      marketCap: mc,
      marketCapIsFdv: !pair.marketCap,
      iconUrl: pair.info?.imageUrl || null,
      txns: { h24: tx24, h1: tx1 },
      pairCreatedAt: pair.pairCreatedAt || null,
      dexId: pair.dexId,
      reasons,
      detectedAt: Date.now(),
    });
  }
  return alerts;
}
