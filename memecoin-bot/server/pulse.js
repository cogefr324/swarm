// Live "Pulse" collector - the same idea as Axiom's Pulse page. Listens to PumpPortal's free
// websocket (new Pump.fun launches, per-token trades, migrations to the AMM) and builds the
// New Pairs / Final Stretch / Migrated columns ourselves, in real time, instead of polling
// ranked snapshots. Everything is best-effort: if the socket drops it reconnects, and the rest
// of the app keeps working from the regular feed.
import WebSocket from 'ws';

const WS_URL = 'wss://pumpportal.fun/api/data';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_TOKENS = 700;
const MAX_MIGRATED = 120;
const VIRTUAL_SOL_START = 30; // Pump.fun curve starts with ~30 virtual SOL
const SOL_TO_GRADUATE = 85; // ~85 real SOL fills the curve and triggers migration
const FINAL_STRETCH_AT = 0.5; // >= 50% of the curve filled
const IPFS_GATEWAYS = ['https://pump.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://w3s.link/ipfs/'];

export function createPulse({ fetchJson }) {
  const tokens = new Map(); // mint -> token
  let solUsd = 0;
  let ws = null;
  let connected = false;
  let retry = 0;
  const pendingSubs = new Set();
  const trk = new Map(); // extra (older / migrated) mints we follow only for their trades: mint -> { events: [], at }
  const TRACK_MAX = 400;
  const metaQueue = [];
  let metaActive = 0;

  // ---------- helpers ----------
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const send = (obj) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* ignore */ } };

  function addToken(msg) {
    const mint = msg.mint;
    if (!mint) return null;
    let t = tokens.get(mint);
    if (!t) {
      t = {
        mint, symbol: '', name: '', uri: msg.uri || null, image: null,
        createdAt: Date.now(), initialMcSol: num(msg.marketCapSol) || null,
        marketCapSol: num(msg.marketCapSol), vSol: num(msg.vSolInBondingCurve),
        buys: 0, sells: 0, volSol: num(msg.solAmount), events: [], migrated: false, migratedAt: null, dex: null,
      };
      tokens.set(mint, t);
      pendingSubs.add(mint);
      prune();
    }
    if (msg.symbol) t.symbol = msg.symbol;
    if (msg.name) t.name = msg.name;
    if (msg.uri && !t.uri) t.uri = msg.uri;
    return t;
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.txType || !msg.mint) return;
    if (msg.txType === 'create') { addToken(msg); return; }
    if (msg.txType === 'migrate') {
      const t = tokens.get(msg.mint) || addToken({ mint: msg.mint });
      if (t) { t.migrated = true; t.migratedAt = Date.now(); }
      return;
    }
    if ((msg.txType === 'buy' || msg.txType === 'sell') && !tokens.has(msg.mint) && trk.has(msg.mint)) {
      const x = trk.get(msg.mint);
      x.events.push({ t: Date.now(), buy: msg.txType === 'buy', mc: num(msg.marketCapSol), w: msg.traderPublicKey || null, sol: num(msg.solAmount) });
      if (x.events.length > 800) x.events.splice(0, x.events.length - 800);
      return;
    }
    if (msg.txType === 'buy' || msg.txType === 'sell') {
      const t = tokens.get(msg.mint);
      if (!t) return;
      const sol = num(msg.solAmount);
      if (msg.txType === 'buy') t.buys += 1; else t.sells += 1;
      t.volSol += sol;
      if (num(msg.marketCapSol)) t.marketCapSol = num(msg.marketCapSol);
      if (num(msg.vSolInBondingCurve)) t.vSol = num(msg.vSolInBondingCurve);
      if (!t.initialMcSol && t.marketCapSol) t.initialMcSol = t.marketCapSol;
      t.events.push({ t: Date.now(), buy: msg.txType === 'buy', mc: t.marketCapSol, w: msg.traderPublicKey || null, sol });
      if (t.events.length > 800) t.events.splice(0, t.events.length - 800);
    }
  }

  function prune() {
    if (tokens.size <= MAX_TOKENS) return;
    const live = [...tokens.values()].filter((t) => !t.migrated).sort((a, b) => a.createdAt - b.createdAt);
    while (tokens.size > MAX_TOKENS && live.length) tokens.delete(live.shift().mint);
  }

  // ---------- token metadata (icon) ----------
  // Icons are only fetched for coins actually being shown (not every launch - Pump.fun creates
  // several per second and the IPFS gateways rate-limit hard), 2 at a time, with retries/backoff.
  function ensureMeta(t) {
    if (t.image || !t.uri || t.metaBusy || (t.metaFails || 0) >= 5) return;
    if (t.metaNext && Date.now() < t.metaNext) return;
    t.metaBusy = true;
    metaQueue.push(t);
    runMeta();
  }
  async function runMeta() {
    while (metaActive < 4 && metaQueue.length) {
      const t = metaQueue.shift();
      metaActive++;
      loadMeta(t)
        .catch(() => {})
        .finally(async () => {
          t.metaBusy = false;
          await new Promise((r) => setTimeout(r, 250));
          metaActive--;
          runMeta();
        });
    }
  }
  async function loadMeta(t) {
    const m = /\/ipfs\/(.+)$/.exec(t.uri || '');
    // Ask every gateway at once and take the first answer - one slow/rate-limited gateway no longer stalls the icon.
    const urls = m ? IPFS_GATEWAYS.map((g) => g + m[1]) : [t.uri];
    const json = await Promise.any(
      urls.map((u) => fetchJson(u, 600000).then((j) => { if (j && typeof j === 'object') return j; throw new Error('no data'); }))
    ).catch(() => null);
    if (json) {
      if (json.image) t.image = json.image;
      if (json.name && !t.name) t.name = json.name;
      if (json.symbol && !t.symbol) t.symbol = json.symbol;
      return;
    }
    t.metaFails = (t.metaFails || 0) + 1;
    t.metaNext = Date.now() + 30000 * t.metaFails;
  }

  // ---------- SOL price ----------
  async function updateSol() {
    const j = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, 30000).catch(() => null);
    let p = num(j?.[SOL_MINT]?.usdPrice);
    if (!p) {
      const g = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', 60000).catch(() => null);
      p = num(g?.solana?.usd);
    }
    if (p) solUsd = p;
  }

  // ---------- migrated tokens: enrich from DexScreener (real market cap / liquidity after the AMM) ----------
  async function enrichMigrated() {
    const mints = [...tokens.values()].filter((t) => t.migrated).sort((a, b) => b.migratedAt - a.migratedAt).slice(0, MAX_MIGRATED).map((t) => t.mint);
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, 15000).catch(() => null);
      const best = new Map();
      for (const p of j?.pairs || []) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken?.address;
        const cur = best.get(mint);
        if (!cur || num(p.liquidity?.usd) > num(cur.liquidity?.usd)) best.set(mint, p);
      }
      for (const [mint, p] of best) {
        const t = tokens.get(mint);
        if (!t) continue;
        t.dex = p;
        if (!t.symbol) t.symbol = p.baseToken?.symbol || '';
        if (!t.name) t.name = p.baseToken?.name || '';
        if (!t.image) t.image = p.info?.imageUrl || null;
      }
    }
  }

  // ---------- socket ----------
  function connect() {
    try { ws = new WebSocket(WS_URL); } catch { return scheduleReconnect(); }
    ws.on('open', () => {
      connected = true; retry = 0;
      send({ method: 'subscribeNewToken' });
      send({ method: 'subscribeMigration' });
      const live = [...tokens.values()].filter((t) => !t.migrated).map((t) => t.mint);
      for (let i = 0; i < live.length; i += 100) send({ method: 'subscribeTokenTrade', keys: live.slice(i, i + 100) });
      console.log('[pulse] connected to PumpPortal');
    });
    ws.on('message', (data) => { try { handleMessage(JSON.parse(data.toString())); } catch { /* ignore bad frame */ } });
    ws.on('close', () => { connected = false; scheduleReconnect(); });
    ws.on('error', (e) => { if (retry === 0) console.warn('[pulse] socket error:', e.message); });
  }
  function scheduleReconnect() {
    retry++;
    setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(retry, 5)));
  }

  // ---------- entries ----------
  function windowStats(t, ms) {
    const cut = Date.now() - ms;
    let buys = 0, sells = 0, first = null;
    for (const e of t.events) {
      if (e.t < cut) continue;
      if (e.buy) buys++; else sells++;
      if (first === null) first = e.mc;
    }
    const change = first && t.marketCapSol ? (t.marketCapSol / first - 1) * 100 : 0;
    return { buys, sells, change };
  }

  function toEntry(t) {
    const d = t.dex;
    const w5 = windowStats(t, 5 * 60 * 1000), w1 = windowStats(t, 3600 * 1000);
    const progress = t.migrated ? 1 : Math.max(0, Math.min(1, (t.vSol - VIRTUAL_SOL_START) / SOL_TO_GRADUATE));
    const sinceLaunch = t.initialMcSol && t.marketCapSol ? (t.marketCapSol / t.initialMcSol - 1) * 100 : 0;
    const base = {
      mint: t.mint,
      pairAddress: d?.pairAddress || null,
      symbol: t.symbol || d?.baseToken?.symbol || '?',
      name: t.name || d?.baseToken?.name || t.symbol || '?',
      priceUsd: d ? num(d.priceUsd) : 0,
      liquidityUsd: d ? num(d.liquidity?.usd) : Math.max(0, t.vSol - VIRTUAL_SOL_START) * solUsd,
      volume24h: d ? num(d.volume?.h24) : t.volSol * solUsd,
      priceChange24h: d && d.priceChange?.h24 != null ? num(d.priceChange.h24) : sinceLaunch,
      priceChange: { m5: d ? num(d.priceChange?.m5) : w5.change, h1: d ? num(d.priceChange?.h1) : w1.change, h6: 0, h24: d ? num(d.priceChange?.h24) : sinceLaunch },
      txns: { m5: { buys: w5.buys, sells: w5.sells }, h1: { buys: w1.buys, sells: w1.sells }, h6: { buys: 0, sells: 0 }, h24: { buys: t.buys, sells: t.sells } },
      pairCreatedAt: t.createdAt,
      marketCap: d ? num(d.marketCap) || num(d.fdv) : t.marketCapSol * solUsd,
      marketCapIsFdv: false,
      iconUrl: t.image || null,
      dexUrl: d?.url || null,
      launchpad: 'Pump',
      bondingProgress: progress,
    };
    if (t.migrated && d?.pairCreatedAt) base.pairCreatedAt = d.pairCreatedAt;
    return base;
  }

  function snapshot() {
    const all = [...tokens.values()].filter((t) => t.symbol || t.dex);
    const live = all.filter((t) => !t.migrated);
    const newPairs = live
      .filter((t) => (t.vSol - VIRTUAL_SOL_START) / SOL_TO_GRADUATE < FINAL_STRETCH_AT)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(toEntry);
    const finalStretch = live
      .filter((t) => (t.vSol - VIRTUAL_SOL_START) / SOL_TO_GRADUATE >= FINAL_STRETCH_AT)
      .sort((a, b) => b.vSol - a.vSol).slice(0, 100).map(toEntry);
    // Migrated coins are shown only once DexScreener has real post-graduation data (market cap,
    // liquidity). Before that, the bonding-curve numbers are meaningless (that's what produced
    // $2-$13 market caps), so those coins wait until the real numbers arrive. Dead ones are hidden.
    const migrated = all
      .filter((t) => t.migrated && t.dex)
      .map(toEntry)
      .filter((e) => e.marketCap >= 5000 && e.liquidityUsd >= 2000 && e.priceChange24h > -80)
      .sort((a, b) => (tokens.get(b.mint).migratedAt || 0) - (tokens.get(a.mint).migratedAt || 0))
      .slice(0, MAX_MIGRATED);
    [...live.filter((t) => !t.image)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).forEach(ensureMeta);
    return { newPairs, finalStretch, migrated, connected, solUsd };
  }


  // Follow the live trades of extra mints (e.g. an older pump.fun coin that is trending now).
  function track(mints) {
    for (const m of mints) {
      if (tokens.has(m)) { trk.delete(m); continue; }
      const x = trk.get(m);
      if (x) { x.seen = Date.now(); continue; }
      trk.set(m, { events: [], at: Date.now(), seen: Date.now() });
      pendingSubs.add(m);
    }
    if (trk.size > TRACK_MAX) {
      const old = [...trk.entries()].sort((a, b) => a[1].seen - b[1].seen).slice(0, trk.size - TRACK_MAX);
      for (const [k] of old) trk.delete(k);
    }
  }
  // Real on-chain activity per window from the trade stream: swaps, buys/sells, unique wallets, SOL volume, price move.
  function tradeStats(mint) {
    const events = tokens.get(mint)?.events || trk.get(mint)?.events;
    if (!events || !events.length) return null;
    const since = tokens.get(mint)?.createdAt || trk.get(mint)?.at || Date.now();
    const calc = (ms) => {
      const cut = Date.now() - ms;
      const w = new Set(), buyers = new Set(), sellers = new Set();
      let swaps = 0, buys = 0, sells = 0, volSol = 0, first = null, last = null;
      for (const e of events) {
        if (e.t < cut) continue;
        swaps++; volSol += e.sol || 0;
        if (e.buy) { buys++; if (e.w) buyers.add(e.w); } else { sells++; if (e.w) sellers.add(e.w); }
        if (e.w) w.add(e.w);
        if (e.mc) { if (first === null) first = e.mc; last = e.mc; }
      }
      return { swaps, buys, sells, wallets: w.size, buyers: buyers.size, sellers: sellers.size, volUsd: volSol * solUsd, change: first && last ? (last / first - 1) * 100 : null, since: Math.min(ms, Date.now() - since) };
    };
    return { m5: calc(5 * 60000), h1: calc(3600000) };
  }

  function start() {
    updateSol(); setInterval(updateSol, 120000);
    setInterval(() => {
      if (!pendingSubs.size) return;
      const keys = [...pendingSubs].slice(0, 100);
      keys.forEach((k) => pendingSubs.delete(k));
      send({ method: 'subscribeTokenTrade', keys });
    }, 2000);
    connect();
  }

  return { start, snapshot, handleMessage, track, tradeStats, _tokens: tokens, _setSol: (v) => { solUsd = v; } };
}
