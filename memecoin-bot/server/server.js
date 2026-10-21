import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { findUserByEmail, findUserById, createUser, readState, writeState, dbMode } from './db.js';
import { sendSignupEmail } from './mailer.js';
import { verify as verifyToken, recentDecisions } from './verifier.js';


// ---- Quiet console: only the important lines. Set LOG_VERBOSE=1 in server/.env to see everything again. ----
const VERBOSE = /^(1|true|verbose)$/i.test(process.env.LOG_VERBOSE || '');
const logStats = { apiErrors: 0, rateLimited: 0, scanned: 0, shown: { top: 0, trending: 0, new: 0 }, hiddenNow: 0, hiddenEver: new Set() };
if (!VERBOSE) {
  const noisy = /^\[(feed|trendingFeed|pulse)\]/;
  const origWarn = console.warn.bind(console);
  console.info = () => {};
  console.warn = (...a) => { if (typeof a[0] === 'string' && noisy.test(a[0])) return; origWarn(...a); };
}
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in server/.env - copy server/.env.example to server/.env and set one (any random string works).');
  process.exit(1);
}


const app = express();
app.set('trust proxy', 1); // behind Railway's proxy: real client IPs for rate limiting
// Express 4 does not catch errors thrown in async handlers - route them to the error handler instead of crashing the server.
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (p, ...h) => (h.length ? orig(p, ...h.map((f) => (typeof f === 'function' ? (req, res, next) => Promise.resolve(f(req, res, next)).catch(next) : f))) : orig(p));
}
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());


// ---- Strict feed filters ----
const TOP_MIN_VOLUME_USD = Number(process.env.TOP_MIN_VOLUME_USD) || 30000; // Top needs real trading
const TOP_MIN_TXNS = Number(process.env.TOP_MIN_TXNS) || 100;
const MIN_VOLUME_USD = 1000; // hide anything under $1,000 24h volume
const MIN_LIQUIDITY_USD = 1000; // optional extra scam filter
const RUG_PER_CYCLE = 30;
const AUTH_PER_CYCLE = 25;
const TRENDING_RUG_SCORE_MAX = 60;


function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}


function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired - please log in again.' });
  }
}


// tiny in-memory rate limit for login / signup (per IP): stops password guessing and signup spam
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = `${req.ip}:${req.path}`; const now = Date.now();
    const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return res.status(429).json({ error: 'Too many attempts - wait a minute and try again.' });
    h.push(now); hits.set(k, h); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 300000).unref();
const SIGNUP_CLOSED = /^(1|true|yes)$/i.test(process.env.SIGNUP_DISABLED || '');
const INVITE_CODE = process.env.INVITE_CODE || '';

app.post('/api/signup', limit(8, 60000), async (req, res) => {
  if (SIGNUP_CLOSED) return res.status(403).json({ error: 'Signups are closed right now.' });
  if (INVITE_CODE && String(req.body?.invite || '') !== INVITE_CODE) return res.status(403).json({ error: 'Invite code required.' });
  const { email, password } = req.body || {};
  if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });


  if (await findUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });


  const passwordHash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  let user;
  try { user = await createUser({ id, email, passwordHash, createdAt: Date.now() }); } catch (e) { if (e.code === 'DUP') return res.status(409).json({ error: 'An account with that email already exists.' }); throw e; }


  sendSignupEmail(user.email); // fire and forget - never blocks signup


  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email } });
});


app.post('/api/login', limit(15, 60000), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });


  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });


  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });


  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email } });
});


app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({ id: user.id, email: user.email });
});


app.get('/api/state', authMiddleware, async (req, res) => {
  const state = await readState(req.userId);
  res.json({ state });
});


app.put('/api/state', authMiddleware, async (req, res) => {
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Missing state.' });
  await writeState(req.userId, state);
  res.json({ ok: true });
});


// ---- Discovery feed: built here on a timer and cached, so every client gets the same consistent
// data from one cheap request and the third-party APIs are only hit a few times a minute total.
// If a refresh fails, the last good feed keeps being served (never goes empty/flaky).
import { buildFeed, cgToEntry, isLaunchpadDex, dexPairToEntry, ALL_LAUNCHPADS, jupToLabel, launchpadFromMint, launchpadLabel, LAUNCHPAD_ONLY, aggregatePairs, isFakeMarket, cleanTop, trendMomentum, isDumpingOrFake } from '../src/feedCore.js';
import { createPulse } from './pulse.js';
import { summaryVerdict } from '../src/rugAnalysis.js';
import { SERVER_VERSION } from '../src/version.js';
import { rpc as chainRpc } from './onchain-bundle.js';
import { requestChartScan, chartState, chartStats } from './chartscan.js';
import { requestWashScan, washState, washStats } from './washtrade.js';
import { requestBundleScan, bundleState, bundleStats } from './onchain-bundle.js';
import { conyrRefresh, conyrEnabled, conyrStatus } from './conyr.js';
import { refreshBubbles, refreshReports, holderBlock, bubbleEnabled, bubbleStatus } from './bubblemaps.js';


const FEED_REFRESH_MS = 12000;
let feedCache = null; // { at, data }
let feedRefreshing = false;
const rawCache = new Map(); // url -> { at, data }


function ttlFor(url) {
  if (url.includes('coingecko.com')) return url.includes('/coins/list') ? 24 * 3600 * 1000 : 5 * 60 * 1000;
  if (url.includes('geckoterminal.com')) {
    if (/\/dexes\?page/.test(url)) return 24 * 3600 * 1000; // the DEX list barely changes
    if (/\/dexes\/[^/]+\/pools/.test(url)) return 120 * 1000; // per-launchpad pool lists
    if (/pools\?page=\d&sort=/.test(url)) return 180 * 1000; // top-volume pools
    return 60 * 1000; // new / trending pools - stays inside Gecko's free 30 calls/minute
  }
  if (url.includes('tokens/v2/search')) return 300000;
  if (url.includes('toporganicscore/6h') || url.includes('toporganicscore/1h')) return 180000;
  if (url.includes('toptrending/24h') || url.includes('toptraded/6h')) return 120000;
  if (url.includes('toptrending/6h')) return 60000;
  if (url.includes('price/v3')) return 120000;
  if (url.includes('toporganicscore')) return 300000;
  if (url.includes('toptraded/24h')) return 120000;
  if (url.includes('toptraded/1h')) return 45000;
  if (url.includes('toptrending/1h')) return 30000;
  if (url.includes('toptrending/5m')) return 15000;
  if (url.includes('/recent')) return 30000;
  return 20000; // other Jupiter calls - spaced out so Jupiter's free rate limit (429) isn't hit
}


async function serverFetchJson(url, ttl = ttlFor(url), headers = {}) {
  const hit = rawCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) {
      logStats.apiErrors++; if (r.status === 429) logStats.rateLimited++;
      console.warn(`[feed] ${url.split('?')[0]} -> HTTP ${r.status}${hit ? ' (using last good)' : ''}`);
      return hit ? hit.data : null;
    }
    const data = await r.json();
    rawCache.set(url, { at: Date.now(), data });
    return data;
  } catch (e) {
    logStats.apiErrors++;
    console.warn(`[feed] ${url.split('?')[0]} -> ${e.message}`);
    return hit ? hit.data : null;
  }
}


// Memecoins ranked by market cap from CoinGecko (free), mapped to Solana mint addresses.
const CG = 'https://api.coingecko.com/api/v3';
let cgMintMap = null;
let cgMapFailedAt = 0;
async function getCgMintMap() {
  if (cgMintMap) return cgMintMap;
  if (Date.now() - cgMapFailedAt < 120000) return null; // cooling down after a failure
  const list = await serverFetchJson(`${CG}/coins/list?include_platform=true`);
  if (!Array.isArray(list)) { cgMapFailedAt = Date.now(); return null; }
  const map = {};
  for (const c of list) if (c.platforms?.solana) map[c.id] = c.platforms.solana;
  cgMintMap = map;
  return map;
}
async function topMemes() {
  // Several pages of 250 per category, ordered by market cap - covers every Solana memecoin down to ~$1M.
  const cats = ['solana-meme-coins', 'pump-fun-ecosystem'];
  const urls = [];
  for (const cat of cats) for (let page = 1; page <= (cat === 'solana-meme-coins' ? 3 : 1); page++) {
    urls.push(`${CG}/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=250&page=${page}&price_change_percentage=24h`);
  }
  const [map, ...pages] = await Promise.all([getCgMintMap(), ...urls.map((u) => serverFetchJson(u))]);
  if (!map) return [];
  const seen = new Set();
  const out = [];
  for (const markets of pages) {
    if (!Array.isArray(markets)) continue;
    for (const m of markets) {
      if (!map[m.id] || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(cgToEntry(m, map[m.id]));
    }
  }
  return out;
}


// ---- Launchpad labels: automatic + corrections you teach it ----
// Jupiter says where a coin was born (launchpad / partnerConfig). Some platforms (Stonk.fun) are not
// recognisable from that alone, so a correction on one coin is also applied to every other coin that
// shares its platform id (partnerConfig), and saved in server/data/launchpads.json.
const LP_FILE = path.join(__dirname, 'data', 'launchpads.json');
let lpOverrides = { mints: {}, configs: {} };
try { lpOverrides = { mints: {}, configs: {}, ...JSON.parse(fs.readFileSync(LP_FILE, 'utf8')) }; } catch { /* first run */ }
function saveLp() { try { fs.mkdirSync(path.dirname(LP_FILE), { recursive: true }); fs.writeFileSync(LP_FILE, JSON.stringify(lpOverrides, null, 1)); } catch { /* ignore */ } }
// Where each coin was born, straight from Jupiter (e.g. launchpad "stonkfun"). Looked up once per coin for
// everything that shows up in the lists - GeckoTerminal/DexScreener only know the exchange a coin trades on
// NOW (Raydium, PumpSwap ...), which is why migrated Stonk/Bonk/Bags coins used to be labelled Raydium.
const jupMeta = new Map(); // mint -> { launchpad, partnerConfig, at } | { none: true, at }
async function enrichLaunchpads(entries) {
  const now = Date.now();
  const need = [];
  for (const e of entries) {
    const m = jupMeta.get(e.mint);
    if (m && (!m.none || now - m.at < 10 * 60 * 1000)) continue; // known, or looked up recently and not indexed yet
    if (!need.includes(e.mint)) need.push(e.mint);
    if (need.length >= 100) break;
  }
  if (!need.length) return;
  const list = await serverFetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${need.join(',')}`, 60000);
  const byId = new Map((Array.isArray(list) ? list : []).map((t) => [t.id, t]));
  if (!Array.isArray(list)) return; // Jupiter hiccup - try again next cycle
  for (const mint of need) {
    const t = byId.get(mint);
    // Self-teaching: a coin whose mint ends in a platform's vanity suffix (BAGS, bonk, pump...) tells us which
    // platform config id belongs to which launchpad, so every other coin on that config gets the right name.
    const sfx = launchpadFromMint(mint);
    if (t?.partnerConfig && sfx && !lpOverrides.configs[t.partnerConfig]) { lpOverrides.configs[t.partnerConfig] = sfx; saveLp(); }
    jupMeta.set(mint, t ? { launchpad: t.launchpad || null, partnerConfig: t.partnerConfig || null, label: jupToLabel(t), at: now } : { none: true, at: now });
  }
}
// Second opinion on where a coin was born: the DEX of its OLDEST trading pair (DexScreener lists every pair
// for a mint, 30 mints per call). A coin whose first pool was a bonding curve (pump, moonshot, stonkfun ...)
// was launched there, even after it migrated to Raydium/PumpSwap.
const firstDex = new Map(); // mint -> { label|null, at }
const dexFirstLabel = (pairs) => {
  const oldest = pairs.filter((p) => p.pairCreatedAt && p.dexId).sort((a, b) => a.pairCreatedAt - b.pairCreatedAt)[0];
  if (!oldest) return null;
  const lab = launchpadLabel(oldest.dexId, null, oldest.labels?.join(' '));
  return LAUNCHPAD_ONLY.has(lab) && lab !== 'PumpSwap' ? lab : null;
};
async function enrichFirstDex(entries) {
  const now = Date.now();
  const need = [];
  for (const e of entries) {
    const m = jupMeta.get(e.mint);
    if (m && !m.none && (m.launchpad || m.partnerConfig)) continue; // Jupiter already knows
    if (launchpadFromMint(e.mint)) continue; // vanity suffix already tells us
    const f = firstDex.get(e.mint);
    if (f && now - f.at < 3600 * 1000) continue;
    if (!need.includes(e.mint)) need.push(e.mint);
    if (need.length >= 90) break;
  }
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    const data = await serverFetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, 60000).catch(() => null);
    if (!data?.pairs) continue;
    const by = new Map();
    for (const p of data.pairs) { if (p.chainId !== 'solana' || !p.baseToken?.address) continue; (by.get(p.baseToken.address) || by.set(p.baseToken.address, []).get(p.baseToken.address)).push(p); }
    for (const m of chunk) firstDex.set(m, { label: dexFirstLabel(by.get(m) || []), at: now });
  }
}
const relabel = (e) => {
  const meta = jupMeta.get(e.mint);
  const label = lpOverrides.mints[e.mint]
    || ((e.partnerConfig || meta?.partnerConfig) && lpOverrides.configs[e.partnerConfig || meta.partnerConfig])
    || (meta && !meta.none && (meta.launchpad || meta.partnerConfig) ? meta.label : null)
    || (!launchpadFromMint(e.mint) ? firstDex.get(e.mint)?.label : null);
  return label && label !== e.launchpad ? { ...e, launchpad: label, fromLaunchpad: true } : e;
};
async function jupiterToken(mint) {
  const list = await serverFetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, 600000);
  return Array.isArray(list) ? list.find((t) => t.id === mint) || null : null;
}


// ---- Big-coin memory for Top ----
// Every memecoin we ever see at $3M+ is remembered (saved in server/data) and re-priced through
// DexScreener, so a coin like MASK stays in Top even when it drops out of the trending/volume lists.
const WATCH_FILE = path.join(__dirname, 'data', 'topwatch.json');
const watch = new Map(); // mint -> { launchpad, symbol, name, iconUrl }
const watchSnap = new Map(); // mint -> latest feed entry
let watchCursor = 0;
let watchDirty = false;
try {
  for (const [mint, meta] of JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'))) watch.set(mint, meta);
  console.log(`[feed] remembered ${watch.size} big coins from earlier runs`);
} catch { /* first run */ }
setInterval(() => {
  if (!watchDirty) return;
  watchDirty = false;
  try { fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true }); fs.writeFileSync(WATCH_FILE, JSON.stringify([...watch.entries()])); } catch { /* ignore */ }
}, 30000);


// ---- Pinned big memecoins ----
// Coins that must always be in Top once they are $10M+ (TRUMP, MASK, ANSEM ...), found by symbol on
// DexScreener (best Solana pair by market cap with real liquidity, so copycat tokens are ignored).
// Add your own symbols or mints to server/data/pinned.json, e.g. ["WIF", "SomeMint..."].
const PINNED_DEFAULT = ['TRUMP', 'MASK', 'ANSEM', 'MELANIA', 'WIF', 'BONK', 'POPCAT', 'FARTCOIN', 'PENGU', 'GOAT', 'PNUT', 'MOODENG', 'BOME', 'MEW', 'GIGA', 'USELESS', 'MICHI', 'SPX', 'PUMP', 'CHILLGUY', 'ACT', 'FWOG', 'RETARDIO', 'SIGMA', 'TREMP', 'LIBRA', 'AI16Z', 'ZEREBRO', 'GRIFFAIN', 'SNAP'];
const PINNED_FILE = path.join(__dirname, 'data', 'pinned.json');
const pinnedDone = new Map(); // symbol -> time resolved
async function seedPinned() {
  let list = PINNED_DEFAULT;
  try { list = [...new Set([...PINNED_DEFAULT, ...JSON.parse(fs.readFileSync(PINNED_FILE, 'utf8'))])]; } catch { /* no custom file */ }
  let budget = 12; // lookups per cycle
  for (const item of list) {
    if (budget <= 0) break;
    const key = String(item);
    if (Date.now() - (pinnedDone.get(key) || 0) < 6 * 3600 * 1000) continue;
    pinnedDone.set(key, Date.now());
    budget--;
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) { // a mint
      if (!watch.has(key)) { watch.set(key, {}); watchDirty = true; }
      continue;
    }
    const sym = key.toUpperCase();
    // 1) Jupiter search by symbol: exact symbol, real liquidity, biggest market cap (copycats are tiny)
    const jl = await serverFetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(sym)}`, 600000).catch(() => null);
    // pick the token that is actually TRADED (24h volume), not the one with the biggest (possibly fake) market cap
    const jvol = (t) => (Number(t.stats24h?.buyVolume) || 0) + (Number(t.stats24h?.sellVolume) || 0);
    const jbest = (Array.isArray(jl) ? jl : []).filter((t) => (t.symbol || '').toUpperCase() === sym && (t.liquidity || 0) >= 20000 && (t.mcap || t.fdv || 0) >= 3e6 && jvol(t) >= 20000 && !(t.liquidity > 0.8 * (t.mcap || t.fdv || 0)))
      .sort((a, b) => jvol(b) - jvol(a))[0];
    // 2) DexScreener search as a backup
    const data = jbest ? null : await serverFetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`, 600000).catch(() => null);
    const dbest = (data?.pairs || []).filter((p) => p.chainId === 'solana' && (p.baseToken?.symbol || '').toUpperCase() === sym
      && (p.liquidity?.usd || 0) >= 20000 && (p.marketCap || p.fdv || 0) >= 3e6 && (p.volume?.h24 || 0) >= 20000 && (p.liquidity?.usd || 0) <= 0.8 * (p.marketCap || p.fdv || 1))
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    const found = jbest ? { mint: jbest.id, symbol: jbest.symbol, name: jbest.name, iconUrl: jbest.icon || null } : dbest ? { mint: dbest.baseToken.address, symbol: dbest.baseToken.symbol, name: dbest.baseToken.name, iconUrl: dbest.info?.imageUrl || null } : null;
    if (found && !watch.has(found.mint)) {
      watch.set(found.mint, { symbol: found.symbol, name: found.name, iconUrl: found.iconUrl });
      watchDirty = true;
      console.log(`[feed] pinned ${sym} -> ${found.mint}`);
    } else if (!found) {
      vlog(`[feed] pinned ${sym}: no Solana token with that symbol and real liquidity found (add its address to server/data/pinned.json)`);
    }
  }
}


const groupPairs = (pairs) => {
  const g = new Map();
  for (const p of pairs || []) { if (p.chainId !== 'solana' || !p.baseToken?.address) continue; (g.get(p.baseToken.address) || g.set(p.baseToken.address, []).get(p.baseToken.address)).push(p); }
  return g;
};
async function mergeWatch(top) {
  const inTop = new Set(top.map((e) => e.mint));
  for (const e of top) {
    if (e.marketCap >= 3e6 && !watch.has(e.mint)) { watch.set(e.mint, { launchpad: e.launchpad, partnerConfig: e.partnerConfig || null, symbol: e.symbol, name: e.name, iconUrl: e.iconUrl }); watchDirty = true; }
  }
  const others = [...watch.keys()].filter((m) => !inTop.has(m));
  // re-price up to 90 remembered coins per cycle (3 DexScreener calls), rotating through all of them
  const batch = [];
  for (let i = 0; i < Math.min(90, others.length); i++) batch.push(others[(watchCursor + i) % others.length]);
  watchCursor = others.length ? (watchCursor + 90) % others.length : 0;
  for (let i = 0; i < batch.length; i += 30) {
    const chunk = batch.slice(i, i + 30);
    const data = await serverFetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, 20000);
    for (const [mint, group] of groupPairs(data?.pairs)) {
      const entry = aggregatePairs(group, watch.get(mint) || {});
      if (!entry) continue;
      watchSnap.set(mint, entry);
      // forget coins that faded out, and copycats/fake markets that were remembered by mistake
      if ((entry.marketCap > 0 && entry.marketCap < 1e6) || isFakeMarket(entry)) { watch.delete(mint); watchSnap.delete(mint); watchDirty = true; }
    }
  }
  const extras = others.map((m) => watchSnap.get(m)).filter((e) => e && e.marketCap >= 10e6 && e.priceChange24h > -80 && e.liquidityUsd >= 1000);
  return cleanTop([...top, ...extras]).slice(0, 200);
}


// ---- Hide rugs / fake-cap coins from every list ----
// RugCheck summary per mint, cached 20 min, filled in a few per cycle so we never hammer it.
const rugCache = new Map(); // mint -> { at, v }  (v = verdict or null when RugCheck had nothing)
const RUG_TTL = 20 * 60 * 1000;
// What we know about every coin that shows up in a list. Anything mintable / freezable, or whose liquidity the
// dev can still pull (LP unlocked), is hidden - checked on-chain (RPC) and with RugCheck, a few coins per cycle.
const safety = new Map(); // mint -> { mintable, freezable, authAt }
const authFail = new Map(); // mint -> failed on-chain lookups (after 3 we stop holding the coin back)
async function fullLpPct(mint) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const rep = await r.json();
    const ms = (rep.markets || []).filter((m) => m?.lp && m.lp.lpLockedPct != null);
    if (!ms.length) return null;
    ms.sort((a, b) => (Number(b.lp.lpTotalUSD) || 0) - (Number(a.lp.lpTotalUSD) || 0));
    return Number(ms[0].lp.lpLockedPct);
  } catch { return null; }
}
const topShown = new Map(); // mint -> last time it passed every Top rule
async function checkListSafety({ top, trending, newPairs }) {
  const prio = [...newPairs.slice(0, 60), ...trending.slice(0, 60), ...top, ...trending.slice(60)];
  const seen = new Set();
  const order = prio.filter((e) => !seen.has(e.mint) && seen.add(e.mint));


  // 1) mint / freeze authority straight from the chain (an authority that is revoked can never come back)
  const needAuth = order.filter((e) => {
    const x = safety.get(e.mint);
    if (!x && (authFail.get(e.mint) || 0) >= 3) return false;
    return !x || (x.authAt && (x.mintable || x.freezable) && Date.now() - x.authAt > 10 * 60 * 1000);
  }).slice(0, AUTH_PER_CYCLE);


  await Promise.all(needAuth.map(async (e) => {
    const hit = mintInfoCache.get(e.mint);
    const v = hit && Date.now() - hit.at < 600000 ? hit.v : await fetchMintInfo(e.mint);
    if (v.ok) {
      mintInfoCache.set(e.mint, { at: Date.now(), v });
      safety.set(e.mint, { mintable: !!v.mintAuthority, freezable: !!v.freezeAuthority, authAt: Date.now() });
    } else {
      authFail.set(e.mint, (authFail.get(e.mint) || 0) + 1);
    }
  }));


  // 2) RugCheck: rugged / risk score / LP locked. The summary is cheap; when it has no LP number we
  //    look in the full report (a few per cycle).
  const needRug = order.filter((e) => {
    const h = rugCache.get(e.mint);
    return !h || Date.now() - h.at > RUG_TTL;
  }).slice(0, RUG_PER_CYCLE);


  await Promise.all(needRug.map(async (e) => {
    try {
      const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${e.mint}/report/summary`, { signal: AbortSignal.timeout(6000) });
      if (r.status === 429) return; // try again next cycle
      rugCache.set(e.mint, { at: Date.now(), v: r.ok ? summaryVerdict(await r.json()) : null });
    } catch { /* retry next cycle */ }
  }));


  let fullBudget = 8;
  for (const e of order) {
    if (fullBudget <= 0) break;
    const c = rugCache.get(e.mint);
    if (c?.v && c.v.lpLockedPct == null && !c.v.lpUnlocked && !c.fullTried) {
      c.fullTried = true; fullBudget--;
      const pct = await fullLpPct(e.mint);
      if (pct != null) { c.v.lpLockedPct = pct; c.v.lpUnlocked = pct < 1; }
    }
  }


  // 2b) holder clusters / bundles (Bubblemaps if a key is set, RugCheck insiders/top-holders always)
  const live = order.filter((e) => { const x = safety.get(e.mint); return !x || !(x.mintable || x.freezable); }).map((e) => e.mint);
  await Promise.all([refreshBubbles(live), refreshReports(live), conyrRefresh(live, 1)]);


  // 3) strict filter - applies to Top, Trending, and New Pairs
  const DAY = 24 * 3600 * 1000;
  const young = (e, days) => !e.pairCreatedAt || Date.now() - e.pairCreatedAt < days * DAY;
  const onCurve = (e) => e.bondingProgress != null && e.bondingProgress < 1; // bonding curve: no normal LP yet
  const dropped = [];
  const newlyHidden = [];


  const verdict = (e, list, idx = 0) => {
    const x = safety.get(e.mint);
    const v = rugCache.get(e.mint)?.v;
    const checked = rugCache.has(e.mint) && (x?.authAt || (authFail.get(e.mint) || 0) >= 3);


    // Hard blocks everywhere
    if (v?.level === 'rugged') return 'rugged';
    if (x?.mintable) return 'mintable';
    if (x?.freezable) return 'freezable';
    // (LP unlocked is NOT a reason to hide a coin)


    // Bundled / clustered / insider-held supply (the "obvious rug" that passes mint, freeze and LP checks)
    const hb = holderBlock(e.mint, list);
    if (hb) return hb;


    // Only-green chart (bot-driven straight-line climb)
    const cst = chartState(e.pairAddress);
    if (cst.status === 'fake') return `fake chart (only green: +${Math.round((cst.gain || 0) * 100)}%, max dip ${Math.round((cst.maxDD || 0) * 100)}%)`;

    // Fake volume: a few wallets (or one funder's side wallets) trading back and forth. Only confirmed wash trading hides a coin.
    const wsx = washState(e.pairAddress);
    if (wsx.status === 'fake') return `fake volume (${(wsx.reasons || [])[0] || 'wash trading'})`;

    // Show-only-if-proven: Trending and New need a CLEAN on-chain bundle scan (hidden until it is done); Top only hides confirmed bundles.
    const bs = bundleState(e.mint);
    if (bs.status === 'bundled') return `bundled ${bs.pct.toFixed(0)}%`;
    if (list === 'top' && e.pairCreatedAt && Date.now() - e.pairCreatedAt < DAY) return 'too new for Top';
    if (list === 'top') {
      // Top = coins people really trade. A $10M+ cap with tiny volume / few trades is a bot-driven or dead pool (smooth fake climb).
      const tv = Number(e.volume24h ?? 0), t24 = e.txns?.h24, n24 = t24 ? (t24.buys || 0) + (t24.sells || 0) : 0;
      if (tv > 0 && tv < TOP_MIN_VOLUME_USD) return 'low volume for Top';
      if (n24 > 0 && n24 < TOP_MIN_TXNS) return 'few trades for Top';
    }

    // Volume floor everywhere
    const vol = Number(e.volume24h ?? e.volume ?? e.volumeUsd ?? 0);
    if (!(list === 'top' && !vol) && vol < MIN_VOLUME_USD) return `volume < $${MIN_VOLUME_USD}`;


    // Liquidity floor everywhere
    const liq = Number(e.liquidityUsd ?? e.liquidity ?? 0);
    if (!(list === 'top' && !liq) && liq < MIN_LIQUIDITY_USD) return `liquidity < $${MIN_LIQUIDITY_USD}`;




    // New Pairs must be checked before they are shown
    if (list === 'new' && !checked && !onCurve(e)) return 'unchecked';

    // survived every cheap rule -> queue the (slow, free-RPC) bundle scan; Trending/New wait for a clean result
    requestChartScan(e.pairAddress, { prio: list === 'top' ? 0 : 1, rank: idx, young: !!e.pairCreatedAt && Date.now() - e.pairCreatedAt < 12 * 3600000 });
    requestWashScan(e.pairAddress, { prio: list === 'top' ? 1 : 0, rank: idx });
    requestBundleScan(e.mint, { prio: list === 'top' ? 1 : 0, rank: idx, pairCreatedAt: e.pairCreatedAt });
    // not scanned yet = shown (the scan runs in the background and hides the coin the moment it proves a bundle)
    return null;
  };


  // Coins already shown in Top stay for 15 min when the only problem is a soft one (numbers flickering), so lists do not shrink and regrow.
  const SOFT = /^(volume|liquidity|low volume|few trades|too new|unchecked)/;
  const apply = (list, name) => list.filter((e, idx) => {
    let why = verdict(e, name, idx);
    if (name === 'top') { if (!why) topShown.set(e.mint, Date.now()); else if (SOFT.test(why) && Date.now() - (topShown.get(e.mint) || 0) < 15 * 60000) why = null; }
    if (why) { dropped.push(`${e.symbol || e.mint.slice(0, 6)} (${why})`); const k = `${e.mint}:${why}`; if (name === 'top' && why !== 'checking bundles' && !logStats.hiddenEver.has(k)) { logStats.hiddenEver.add(k); newlyHidden.push(`${e.symbol || e.mint.slice(0, 6)} (${why})`); } }
    return !why;
  });


  const out = {
    top: apply(top, 'top'),
    trending: apply(trending, 'trending'),
    newPairs: apply(newPairs, 'new'),
  };


  const uniq = new Set([...top, ...trending, ...newPairs].map((e) => e.mint));
  logStats.scanned = uniq.size;
  logStats.shown = { top: out.top.length, trending: out.trending.length, new: out.newPairs.length };
  logStats.hiddenNow = new Set(dropped.map((d) => d)).size;
  if (newlyHidden.length) {
    const seenN = new Set();
    const uniqNew = newlyHidden.filter((x) => !seenN.has(x) && seenN.add(x));
    console.log(`[filtered:top] ${uniqNew.slice(0, 12).join(', ')}${uniqNew.length > 12 ? ` +${uniqNew.length - 12} more` : ''}`);
  }
  if (logStats.hiddenEver.size > 5000) logStats.hiddenEver.clear();
  return out;
}


// Re-price every Top coin from DexScreener each cycle (CoinGecko's market caps lag and carry no
// liquidity), then enforce the $10M floor on the LIVE number.
const TOP_FLOOR = 10e6;
const repriceCache = new Map(); // mint -> entry
async function repriceTop(top) {
  const mints = top.map((e) => e.mint);
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const data = await serverFetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, 30000).catch(() => null);
    for (const [mint, group] of groupPairs(data?.pairs)) { const e = aggregatePairs(group); if (e) repriceCache.set(mint, e); }
  }
  // market cap = live price x on-chain supply (burn-aware, same number the coin page uses). Supplies are
  // fetched a few per cycle and then cached, so the whole list fills in within a minute or two.
  let budget = 8;
  for (const m of mints) {
    if (budget <= 0) break;
    const c = supplyCache.get(m);
    if (c && Date.now() - c.at < 6 * 3600 * 1000) continue;
    budget--;
    const sup = await fetchSupply(m).catch(() => null);
    if (sup) supplyCache.set(m, { at: Date.now(), supply: sup });
  }
  const out = top.map((e) => {
    const live = repriceCache.get(e.mint);
    if (!live || !(live.marketCap > 0)) return e;
    const merged = { ...e, ...live, launchpad: e.launchpad, partnerConfig: e.partnerConfig || live.partnerConfig, iconUrl: live.iconUrl || e.iconUrl, symbol: e.symbol || live.symbol, name: e.name || live.name };
    const sup = supplyCache.get(e.mint)?.supply;
    if (sup && live.priceUsd > 0) { merged.marketCap = live.priceUsd * sup; merged.marketCapIsFdv = false; }
    return merged;
  }).filter((e) => e.marketCap >= TOP_FLOOR);
  return cleanTop(out);
}


// Which GeckoTerminal DEX ids are launchpads (stonkfun, heaven, candle ...). Looked up once a day.
let launchpadDexCache = null;
async function launchpadDexes() {
  if (launchpadDexCache && Date.now() - launchpadDexCache.at < 6 * 3600 * 1000) return launchpadDexCache.ids;
  const ids = [];
  for (let page = 1; page <= 6; page++) {
    const j = await serverFetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/dexes?page=${page}`);
    const rows = j?.data || [];
    for (const d of rows) if (isLaunchpadDex(d.id, d.attributes?.name)) ids.push(d.id);
    if (rows.length < 20) break;
  }
  if (ids.length) { launchpadDexCache = { at: Date.now(), ids }; vlog(`[feed] launchpad DEXes on GeckoTerminal: ${ids.join(', ')}`); }
  return launchpadDexCache?.ids || ids;
}



// ---- Trending that matches what people are really trading ----
// 1) a ticker can have many copycat tokens: swap each trending entry for the DOMINANT token with that ticker (real volume),
//    so a $23M KIMCHI replaces its 15k copycat; 2) remembered big coins (watch list) that are running right now join the pool;
// 3) rank mostly by live momentum (money in the last hour, trades, price move, buy pressure) like Axiom / DexScreener trending.
const symLookup = new Map(); // SYMBOL -> { at, best }  best = dominant entry or null
const symKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function dominantFor(symbol) {
  const k = symKey(symbol);
  const hit = symLookup.get(k);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.best;
  const data = await serverFetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`, 120000);
  let best = null;
  if (data?.pairs) {
    const exact = data.pairs.filter((p) => p.chainId === 'solana' && symKey(p.baseToken?.symbol) === k);
    for (const [mint, group] of groupPairs(exact)) {
      const e = aggregatePairs(group, watch.get(mint) || {});
      if (!e || isFakeMarket(e)) continue;
      if (!best || (e.volume24h || 0) > (best.volume24h || 0)) best = e;
    }
  }
  symLookup.set(k, { at: Date.now(), best });
  return best;
}
async function improveTrending(trending) {
  const sym = new Map();
  let budget = 10; // new DexScreener lookups per cycle
  const resolved = [];
  for (const e of trending.slice(0, 60)) {
    const k = symKey(e.symbol);
    if (!k) { resolved.push(e); continue; }
    const cached = symLookup.get(k);
    let best = cached && Date.now() - cached.at < 5 * 60000 ? cached.best : undefined;
    if (best === undefined && budget > 0) { budget--; best = await dominantFor(e.symbol).catch(() => null); }
    if (best && best.mint !== e.mint && (best.volume24h || 0) >= 3 * (e.volume24h || 1)) {
      // the real token behind this ticker is far bigger: show it instead of the copycat
      if (best.marketCap >= 3e6 && !watch.has(best.mint)) { watch.set(best.mint, { launchpad: best.launchpad, symbol: best.symbol, name: best.name, iconUrl: best.iconUrl }); watchDirty = true; }
      resolved.push({ ...best, launchpad: relabel(best).launchpad });
    } else resolved.push(e);
  }
  // remembered big coins that are moving right now
  const pool = new Map(resolved.map((e) => [e.mint, e]));
  for (const e of watchSnap.values()) {
    if (pool.has(e.mint) || !(e.marketCap >= 3e6) || isDumpingOrFake(e)) continue;
    const t = e.txns?.h1 || { buys: 0, sells: 0 };
    if (e.liquidityUsd >= 3000 && t.buys + t.sells >= 40 && (e.priceChange?.h1 || 0) > -20) pool.set(e.mint, e);
  }
  const list = [...pool.values()].filter((e) => !isDumpingOrFake(e));
  // one token per ticker: the one with the real volume
  const bySym = new Map();
  for (const e of list) { const k = symKey(e.symbol) || e.mint; const c = bySym.get(k); if (!c || (e.volume24h || 0) > (c.volume24h || 0)) bySym.set(k, e); }
  const uniq = [...bySym.values()];
  if (!uniq.length) return trending;
  const rankOf = new Map(trending.map((e, i) => [e.mint, 1 - i / Math.max(1, trending.length)]));
  const moms = uniq.map(trendMomentum);
  const lo = Math.min(...moms), hi = Math.max(...moms);
  const score = (e, i) => 0.3 * (rankOf.get(e.mint) ?? 0.4) + 0.7 * ((moms[i] - lo) / (hi - lo || 1));
  return uniq.map((e, i) => [e, score(e, i)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 100);
}

async function refreshFeed() {
  if (feedRefreshing) return;
  feedRefreshing = true;
  try {
    const data = await buildFeed({ fetchJson: (u) => serverFetchJson(u), topMemes, launchpadDexes });
    // only replace the cache if the refresh produced something, so a bad cycle never blanks the lists
    await seedPinned().catch(() => {});
    data.top = await mergeWatch(data.top).catch(() => data.top);
    const lpEntries = [...data.top, ...data.trending, ...data.newPairs, ...(data.movers || [])];
    await enrichLaunchpads(lpEntries).catch(() => {});
    await enrichFirstDex(lpEntries).catch(() => {});
    data.top = await repriceTop(data.top).catch(() => data.top.filter((e) => e.marketCap >= TOP_FLOOR));
    data.trending = await improveTrending(data.trending).catch(() => data.trending);
    const pulseNew = (() => { try { return pulse.snapshot().newPairs || []; } catch { return []; } })();
    const safe = await checkListSafety({ top: data.top, trending: data.trending, newPairs: [...pulseNew, ...data.newPairs] });
    data.top = safe.top;
    data.trending = safe.trending;
    data.newPairs = safe.newPairs;
    data.newPairsSafe = new Set(safe.newPairs.map((e) => e.mint));


    // Apply the same $1k volume floor to Movers too
    if (Array.isArray(data.movers)) {
      data.movers = data.movers.filter((e) => Number(e.volume24h ?? e.volume ?? e.volumeUsd ?? 0) >= MIN_VOLUME_USD);
    }


    if (data.trending.length || data.top.length || data.newPairs.length) feedCache = { at: Date.now(), data };
  } catch (e) {
    console.warn('[feed] refresh failed, keeping last good feed:', e.message);
  } finally {
    feedRefreshing = false;
  }
}
refreshFeed();
setInterval(refreshFeed, FEED_REFRESH_MS);


const pulse = createPulse({ fetchJson: (u, ttl) => serverFetchJson(u, ttl) });
pulse.start();


app.get('/api/feed', authMiddleware, async (req, res) => {
  if (!feedCache) await refreshFeed();
  if (!feedCache && !pulse.snapshot().newPairs.length) return res.status(503).json({ error: 'Feed not ready yet - try again in a few seconds.' });
  const base = feedCache ? feedCache.data : { newPairs: [], trending: [], top: [], launchpads: [] };
  const p = pulse.snapshot();


  // New Pairs = only checked, non-scam, $1k+ volume launches
  const seen = new Set();
  const newPairs = [...p.newPairs, ...base.newPairs]
    .filter((e) => e.pairCreatedAt && !seen.has(e.mint) && seen.add(e.mint))
    .sort((a, b) => b.pairCreatedAt - a.pairCreatedAt)
    .filter((e) => base.newPairsSafe?.has(e.mint)) // STRICT: no unchecked launches
    .slice(0, 100);


  const rl = (list) => (list || []).map(relabel);


  res.json({
    ...base,
    newPairsSafe: undefined,
    trending: rl(base.trending),
    top: rl(base.top),
    movers: rl(base.movers),
    newPairs: rl(newPairs),
    finalStretch: p.finalStretch,
    migrated: p.migrated,
    pulseConnected: p.connected,
    updatedAt: feedCache?.at || Date.now(),
    serverVersion: SERVER_VERSION,
    bubblemaps: bubbleStatus(),
    conyr: conyrStatus(),
    bundleScan: bundleStats(),
    washScan: washStats(),
    chartScan: chartStats(),
  });
});



// ---- Phantom / wallet sync (read-only: parses a wallet's swaps and balances from free RPC) ----
const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNyFexT4ysSFvkjtnQ']); // USDC, USDT
const isAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));
async function solUsdNow() {
  const d = await serverFetchJson(`https://api.dexscreener.com/latest/dex/tokens/${WSOL}`, 30000);
  const best = (d?.pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === WSOL).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return Number(best?.priceUsd) || null;
}
// one transaction -> a buy / sell of exactly one non-quote token by this wallet, or null
export function parseSwap(tx, owner) {
  if (!tx || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(owner);
  if (idx < 0) return null;
  const m = tx.meta || {};
  const lamports = ((m.postBalances?.[idx] ?? 0) - (m.preBalances?.[idx] ?? 0)) + (idx === 0 ? (m.fee || 0) : 0); // network fee is not part of the trade
  const d = new Map(); // mint -> ui delta for this owner
  const add = (list, sign) => { for (const b of list || []) if (b.owner === owner) d.set(b.mint, (d.get(b.mint) || 0) + sign * (Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount) || 0)); };
  add(m.postTokenBalances, 1); add(m.preTokenBalances, -1);
  const solEq = lamports / 1e9 + (d.get(WSOL) || 0);
  let usd = 0; for (const [mint, v] of d) if (STABLES.has(mint)) usd += v;
  const others = [...d.entries()].filter(([mint, v]) => mint !== WSOL && !STABLES.has(mint) && Math.abs(v) > 0);
  if (others.length !== 1) return null;
  const [mint, tokens] = others[0];
  const side = tokens > 0 ? 'buy' : 'sell';
  if (side === 'buy' && solEq > -0.0005 && usd > -0.01) return null;   // received tokens without paying: airdrop / transfer
  if (side === 'sell' && solEq < 0.0005 && usd < 0.01) return null;     // sent tokens without being paid: transfer
  return { side, mint, tokens: Math.abs(tokens), sol: Math.abs(solEq) > 0.0005 ? Math.abs(solEq) : 0, usdStable: Math.abs(usd) > 0.01 ? Math.abs(usd) : 0, time: tx.blockTime || null };
}
app.get('/api/wallet/sync', authMiddleware, async (req, res) => {
  const address = String(req.query.address || '');
  const since = req.query.since ? String(req.query.since) : null;
  if (!isAddr(address)) return res.status(400).json({ error: 'bad address' });
  const sigs = await chainRpc('getSignaturesForAddress', [address, { limit: since ? 40 : 20, ...(since ? { until: since } : {}) }]);
  if (!sigs.ok) return res.status(502).json({ error: `RPC: ${sigs.error}` });
  const list = (sigs.result || []).filter((x) => !x.err);
  const trades = [];
  for (const sg of list.slice().reverse()) { // oldest first
    const tx = await chainRpc('getTransaction', [sg.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx.ok) continue;
    const t = parseSwap(tx.result, address);
    if (t) trades.push({ sig: sg.signature, ...t, time: t.time || sg.blockTime || null });
  }
  res.json({ trades, newest: sigs.result?.[0]?.signature || since, solUsd: await solUsdNow() });
});
app.get('/api/wallet/holdings', authMiddleware, async (req, res) => {
  const address = String(req.query.address || '');
  if (!isAddr(address)) return res.status(400).json({ error: 'bad address' });
  const [bal, a1, a2, solUsd] = await Promise.all([
    chainRpc('getBalance', [address]),
    chainRpc('getTokenAccountsByOwner', [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]),
    chainRpc('getTokenAccountsByOwner', [address, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]),
    solUsdNow(),
  ]);
  if (!bal.ok) return res.status(502).json({ error: `RPC: ${bal.error}` });
  const per = new Map();
  for (const a of [...(a1.result?.value || []), ...(a2.result?.value || [])]) {
    const i = a.account?.data?.parsed?.info; if (!i) continue;
    const ui = Number(i.tokenAmount?.uiAmountString ?? i.tokenAmount?.uiAmount) || 0;
    if (ui > 0) per.set(i.mint, (per.get(i.mint) || 0) + ui);
  }
  per.delete(WSOL);
  const mints = [...per.keys()].slice(0, 90);
  const info = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const d = await serverFetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(',')}`, 15000);
    for (const [mint, group] of groupPairs(d?.pairs)) { const e = aggregatePairs(group); if (e) info.set(mint, e); }
  }
  const holdings = mints.map((mint) => { const e = info.get(mint); return { mint, amount: per.get(mint), symbol: e?.symbol || null, name: e?.name || null, iconUrl: e?.iconUrl || null, priceUsd: e?.priceUsd || null, marketCap: e?.marketCap || null, liquidityUsd: e?.liquidityUsd || null, valueUsd: e?.priceUsd ? e.priceUsd * per.get(mint) : null }; })
    .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  res.json({ address, sol: (bal.result?.value || 0) / 1e9, solUsd, holdings });
});


// Relay a transaction the user already signed in Phantom (the server never sees a private key) + check its status + token decimals.
app.post('/api/wallet/send', authMiddleware, async (req, res) => {
  const tx = String(req.body?.tx || '');
  if (!/^[A-Za-z0-9+/=]{100,6000}$/.test(tx)) return res.status(400).json({ error: 'bad transaction' });
  const r = await chainRpc('sendTransaction', [tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
  if (!r.ok) return res.status(502).json({ error: `RPC: ${r.error}` });
  res.json({ signature: r.result });
});
app.get('/api/wallet/status', authMiddleware, async (req, res) => {
  const sig = String(req.query.sig || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return res.status(400).json({ error: 'bad signature' });
  const r = await chainRpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  if (!r.ok) return res.status(502).json({ error: `RPC: ${r.error}` });
  const v = r.result?.value?.[0];
  res.json({ found: !!v, confirmed: !!v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized'), err: v?.err || null });
});
app.get('/api/wallet/decimals', authMiddleware, async (req, res) => {
  const mint = String(req.query.mint || '');
  if (!isAddr(mint)) return res.status(400).json({ error: 'bad mint' });
  const r = await chainRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const d = r.result?.value?.data?.parsed?.info?.decimals;
  if (!r.ok || d == null) return res.status(502).json({ error: 'could not read token decimals' });
  res.json({ decimals: d });
});

// Token identity + scam verification (see verifier.js). Returns buy_allowed / buy_blocked with every reason.
app.get('/api/verify', authMiddleware, async (req, res) => {
  const mint = String(req.query.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'bad mint' });
  const ticker = String(req.query.ticker || '').slice(0, 30) || undefined;
  const mode = req.query.mode === 'dry-run' ? 'dry-run' : req.query.mode === 'enforce' ? 'enforce' : undefined;
  try { res.json(await verifyToken({ mint, ticker, mode })); }
  catch (e) { res.status(500).json({ decision: 'buy_blocked', reasons: [`verification error: ${e.message}`], retryable: true, enforced: true }); }
});
app.get('/api/verify-log', authMiddleware, (req, res) => res.json({ decisions: recentDecisions(Math.min(200, Number(req.query.limit) || 50)) }));


// "Pin to Top": remember a coin by address so it always appears in Top once it is $10M+.
app.post('/api/pin', authMiddleware, (req, res) => {
  const mint = String(req.body?.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'bad mint' });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PINNED_FILE, 'utf8')); } catch { /* new file */ }
  if (!list.includes(mint)) list.push(mint);
  try { fs.mkdirSync(path.dirname(PINNED_FILE), { recursive: true }); fs.writeFileSync(PINNED_FILE, JSON.stringify(list, null, 1)); } catch { /* ignore */ }
  if (!watch.has(mint)) { watch.set(mint, {}); watchDirty = true; }
  res.json({ ok: true });
});


app.get('/api/launchpad', authMiddleware, async (req, res) => {
  const mint = String(req.query.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.json({ label: null });
  const t = await jupiterToken(mint).catch(() => null);
  const taught = lpOverrides.mints[mint] || (t?.partnerConfig && lpOverrides.configs[t.partnerConfig]);
  // only count it as evidence when Jupiter actually names a launchpad/platform (not just the exchange it trades on)
  const auto = t && (t.launchpad || t.partnerConfig) ? jupToLabel(t) : launchpadFromMint(mint);
  let label = taught || auto || null;
  let how = taught ? 'saved' : t && (t.launchpad || t.partnerConfig) ? 'jupiter' : auto ? 'mint suffix' : null;
  if (!label) {
    await enrichFirstDex([{ mint }]).catch(() => {});
    label = firstDex.get(mint)?.label || null;
    if (label) how = 'first pool';
  }
  res.json({ label, taught: !!taught, how, raw: t ? { launchpad: t.launchpad || null, partnerConfig: t.partnerConfig || null } : null });
});


// Teach it: POST { mint, label } (label from the launchpad list, or "" to go back to automatic).
app.post('/api/launchpad', authMiddleware, async (req, res) => {
  const mint = String(req.body?.mint || '');
  const label = String(req.body?.label || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'bad mint' });
  if (label && !ALL_LAUNCHPADS.includes(label)) return res.status(400).json({ error: 'unknown launchpad' });
  const t = await jupiterToken(mint).catch(() => null);
  if (!label) {
    delete lpOverrides.mints[mint];
    if (t?.partnerConfig) delete lpOverrides.configs[t.partnerConfig];
  } else {
    lpOverrides.mints[mint] = label;
    if (t?.partnerConfig) lpOverrides.configs[t.partnerConfig] = label; // every coin on the same platform gets it too
  }
  saveLp();
  console.log(`[launchpad] ${mint} -> ${label || 'automatic'}${t?.partnerConfig ? ` (platform ${t.partnerConfig} ${label ? 'learned' : 'cleared'})` : ''}; Jupiter says launchpad=${t?.launchpad || '-'}`);
  res.json({ ok: true, label: label || null, platformLearned: !!(label && t?.partnerConfig) });
});


// ---- On-chain supply lookup (so the browser never talks to public RPCs directly) ----
const RPCS = ['https://solana.api.onfinality.io/public', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const rpcBlockedUntil = RPCS.map(() => 0);
const supplyCache = new Map(); // mint -> { at, supply }
const supplyInFlight = new Map();


async function fetchSupply(mint) {
  for (let i = 0; i < RPCS.length; i++) {
    if (Date.now() < rpcBlockedUntil[i]) continue;
    try {
      const r = await fetch(RPCS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
        signal: AbortSignal.timeout(6000),
      });
      if (r.status === 429 || r.status === 403) { rpcBlockedUntil[i] = Date.now() + 30000; continue; }
      const data = await r.json();
      const info = data?.result?.value;
      const supply = info ? parseFloat(info.uiAmountString ?? info.uiAmount ?? 0) : 0;
      if (supply > 0) return supply;
    } catch { rpcBlockedUntil[i] = Date.now() + 10000; }
  }
  return null;
}


// Always answers 200 (supply: null on failure) so a lookup problem never shows up as a red browser error.
app.get('/api/supply', authMiddleware, async (req, res) => {
  const mint = String(req.query.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.json({ supply: null });
  const hit = supplyCache.get(mint);
  if (hit && Date.now() - hit.at < 60000) return res.json({ supply: hit.supply });
  if (!supplyInFlight.has(mint)) {
    supplyInFlight.set(mint, fetchSupply(mint).finally(() => supplyInFlight.delete(mint)));
  }
  const supply = await supplyInFlight.get(mint);
  if (supply) supplyCache.set(mint, { at: Date.now(), supply });
  res.json({ supply: supply ?? hit?.supply ?? null });
});


// ---- Mint / freeze authority check (used by the early-gem scanner, like SolBot's mintSafe) ----
const mintInfoCache = new Map();
async function fetchMintInfo(mint) {
  for (let i = 0; i < RPCS.length; i++) {
    if (Date.now() < rpcBlockedUntil[i]) continue;
    try {
      const r = await fetch(RPCS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] }),
        signal: AbortSignal.timeout(6000),
      });
      if (r.status === 429 || r.status === 403) { rpcBlockedUntil[i] = Date.now() + 30000; continue; }
      const info = (await r.json())?.result?.value?.data?.parsed?.info;
      if (!info) return { ok: false, retryable: false, why: 'not a parsed token mint' };
      return { ok: true, mintAuthority: !!info.mintAuthority, freezeAuthority: !!info.freezeAuthority };
    } catch { rpcBlockedUntil[i] = Date.now() + 10000; }
  }
  return { ok: false, retryable: true, why: 'RPC unavailable' };
}
app.get('/api/mintinfo', authMiddleware, async (req, res) => {
  const mint = String(req.query.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.json({ ok: false, retryable: false, why: 'bad mint' });
  const hit = mintInfoCache.get(mint);
  if (hit && Date.now() - hit.at < 600000) return res.json(hit.v);
  const v = await fetchMintInfo(mint);
  if (v.ok) mintInfoCache.set(mint, { at: Date.now(), v });
  res.json(v);
});


// ---- Image proxy for IPFS-hosted coin icons (public gateways block cross-site loads) ----
const IPFS_GATEWAYS = ['https://pump.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://w3s.link/ipfs/', 'https://nftstorage.link/ipfs/'];
const imgCache = new Map(); // path -> { type, buf }
const imgFail = new Map(); // path -> time of last total failure
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');


app.get('/api/img', async (req, res) => {
  const p = String(req.query.p || '');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (!/^[A-Za-z0-9]{10,100}(\/[\w.\-]{1,100}){0,3}$/.test(p)) return res.status(200).type('image/gif').send(PIXEL);
  let hit = imgCache.get(p);
  if (!hit && Date.now() - (imgFail.get(p) || 0) < 60000) return res.status(200).set('Cache-Control', 'public, max-age=60').type('image/gif').send(PIXEL);
  if (!hit) {
    // Race all gateways at once - first valid image wins, the rest are cancelled. Much faster than
    // trying them one after another (a single slow gateway used to stall the icon for many seconds).
    const ctrl = new AbortController();
    try {
      hit = await Promise.any(
        IPFS_GATEWAYS.map(async (gw) => {
          const r = await fetch(gw + p, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(5000)]) });
          const type = r.headers.get('content-type') || '';
          if (!r.ok || !type.startsWith('image/')) throw new Error('bad');
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 2_000_000) throw new Error('big');
          return { type, buf };
        })
      );
    } catch { hit = null; }
    ctrl.abort();
    if (hit) {
      imgCache.set(p, hit);
      if (imgCache.size > 800) imgCache.delete(imgCache.keys().next().value);
    } else imgFail.set(p, Date.now());
  }
  if (!hit) return res.status(200).set('Cache-Control', 'public, max-age=300').type('image/gif').send(PIXEL);
  res.set('Cache-Control', 'public, max-age=86400').type(hit.type).send(hit.buf);
});


// Serve the built website from this same server (Railway runs ONE service: site + API on one URL).
const DIST = path.join(__dirname, '..', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.warn(`[error] ${req.method} ${req.path}: ${err.message}`);
  if (!res.headersSent) res.status(500).json({ error: 'Server error - try again.' });
});

setInterval(() => {
  const l = logStats; const bs_ = bundleStats(); const ws_ = washStats(); const cs_ = chartStats();
  console.log(`[status] scanned ${l.scanned} | showing top ${l.shown.top}, trending ${l.shown.trending}, new ${l.shown.new} | filtered ${l.hiddenNow} | chart scans: ${cs_.scanned} done, ${cs_.fake} fake | wash scans: ${ws_.scanned} done, ${ws_.fake} fake | bundle scans: ${bs_.scanned} done, ${bs_.bundled} bundled, ${bs_.queued} queued | API errors ${l.apiErrors}${l.rateLimited ? ` (${l.rateLimited} rate-limited)` : ''}`);
  l.apiErrors = 0; l.rateLimited = 0;
}, 60000).unref();

app.listen(PORT, () => {
  console.log(`Trading bot auth/storage server listening on http://localhost:${PORT} (build ${SERVER_VERSION})`);
  console.log(`[db] storage: ${dbMode}${dbMode === 'files' ? ' (set DATABASE_URL to use Postgres)' : ''}`);
  console.log(conyrEnabled() ? '[conyr] enabled (free tier, ~8 req/min)' : '[conyr] no CONYR_API_KEY set - get a free key at conyr.ai/api to turn on hidden-bundle detection');
  console.log(bubbleEnabled() ? '[bubblemaps] enabled' : '[bubblemaps] no BUBBLEMAPS_API_KEY set - using the free RugCheck holder/insider check only');
});