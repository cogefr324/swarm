// Axiom-style trending engine.
//   1. Universe: every coin we know is active (feed lists, big-coin memory, fresh launches, pump.fun stream).
//   2. Aggregate per window (5m / 1h / 6h / 24h): volume, swaps, buys vs sells, price change from DexScreener's free pair data,
//      plus - for pump.fun coins - unique wallets and swaps counted straight from the live trade stream.
//   3. Score = how much activity the coin has in THAT window (volume first, then swaps, wallets, price move, buy pressure).
//   4. Junk filters here are cheap (liquidity, dead chart, dump); the heavy ones (bundles, fake volume, only-green chart,
//      mint/freeze, rugs) run afterwards in checkListSafety.
export const WINDOWS = ['m5', 'h1', 'h6', 'h24'];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// pairs: DexScreener pairs of ONE token -> per-window totals (all pairs summed, price change from the deepest pair)
export function windowsFromPairs(pairs) {
  const list = (pairs || []).filter((p) => p && p.chainId === 'solana');
  const best = list.slice().sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd))[0];
  const out = {};
  for (const w of WINDOWS) {
    let vol = 0, buys = 0, sells = 0;
    for (const p of list) { vol += num(p.volume?.[w]); buys += num(p.txns?.[w]?.buys); sells += num(p.txns?.[w]?.sells); }
    out[w] = { volumeUsd: vol, buys, sells, swaps: buys + sells, priceChange: num(best?.priceChange?.[w]) };
  }
  return out;
}

const MIN_SWAPS = { m5: 6, h1: 25, h6: 80, h24: 200 };
// To be TRENDING a coin must be doing clearly MORE than its own normal. Big old coins (TRUMP) and dead coins with a big cap fail these:
const MIN_TURNOVER = { m5: 0.0005, h1: 0.003, h6: 0.01, h24: 0.03 }; // window volume / market cap
const MIN_MOVE = { m5: 1, h1: 3, h6: 5, h24: 10 };                    // |price change %| in the window - flat churn is not trending
const FRAC = { m5: 5 / 1440, h1: 60 / 1440, h6: 360 / 1440, h24: 1 };
const MIN_ACCEL = { m5: 1.2, h1: 1.1, h6: 1.0, h24: 0 };             // window volume pace vs the coin's own 24h average pace
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function windowScore(win, chain, liquidityUsd, extra = {}) {
  const vol = win.volumeUsd, swaps = win.swaps;
  const uniq = chain?.wallets || 0;
  const buyShare = swaps ? win.buys / swaps : 0.5;
  return 1.8 * Math.log10(1 + vol)
    + 0.5 * Math.log10(1 + 100 * (extra.turnover || 0))
    + 0.5 * Math.log10(1 + (extra.accel || 0))
    + 0.4 * Math.log10(1 + swaps)
    + 0.4 * Math.log10(1 + uniq)
    + 0.8 * Math.tanh(clamp(win.priceChange, -100, 400) / 100)
    + 0.8 * (buyShare - 0.5)
    + 0.3 * Math.min(1, liquidityUsd / 50000);
}

// candidates: [{ entry, win }]  ->  { m5: [entry...], h1: [...], h6: [...], h24: [...] } sorted by score, with .win attached
export function rankWindows(candidates, chainOf, { limit = 60 } = {}) {
  const out = {};
  for (const w of WINDOWS) {
    let rows = [];
    for (const relax of [1, 0.5]) { // if a window comes out thin, retry with half the thresholds so Trending is never empty
    rows = [];
    for (const { entry: e, win } of candidates) {
      const x = win?.[w];
      if (!x) continue;
      if (e.liquidityUsd < (w === 'm5' ? 4000 : 3000)) continue;
      if (x.swaps < MIN_SWAPS[w] * relax) continue;                              // dead chart in this window
      if (x.priceChange <= -60 && w !== 'm5') continue;                   // dumping
      if (w === 'm5' && x.priceChange <= -35) continue;
      if (x.buys >= 20 && x.sells < x.buys * 0.1) continue;               // can't sell = honeypot
      if (x.volumeUsd < 500) continue;
      const mc = Math.max(e.marketCap || 0, 50000);
      const turnover = x.volumeUsd / mc;
      const v24 = win.h24?.volumeUsd || 0;
      const young = e.pairCreatedAt && Date.now() - e.pairCreatedAt < 24 * 3600 * 1000; // no baseline yet: judged on turnover alone
      const accel = v24 > 0 ? (x.volumeUsd / FRAC[w]) / v24 : 99;
      if (turnover < MIN_TURNOVER[w] * relax) continue;                                // big cap, little trading = dead / steady
      if (Math.abs(x.priceChange) < MIN_MOVE[w] * relax) continue;                     // price not moving
      if (!young && w !== 'h24' && accel < MIN_ACCEL[w] * (relax < 1 ? 0.8 : 1)) continue;             // not busier than its own normal
      const chain = chainOf ? chainOf(e.mint)?.[w === 'm5' ? 'm5' : 'h1'] : null;
      rows.push({ e, x, all: win, chain: w === 'm5' || w === 'h1' ? chain : null, s: windowScore(x, w === 'm5' || w === 'h1' ? chain : null, e.liquidityUsd, { turnover, accel: Math.min(accel, 50) }) });
    }
    if (rows.length >= 8) break;
    }
    // one token per ticker: the one with the real activity in this window
    const bySym = new Map();
    for (const r of rows) { const k = String(r.e.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || r.e.mint; const c = bySym.get(k); if (!c || r.x.volumeUsd > c.x.volumeUsd) bySym.set(k, r); }
    out[w] = [...bySym.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((r) => ({
      ...r.e,
      allWin: Object.fromEntries(WINDOWS.map((k) => [k, { volumeUsd: Math.round(r.all?.[k]?.volumeUsd || 0), swaps: r.all?.[k]?.swaps || 0, buys: r.all?.[k]?.buys || 0, sells: r.all?.[k]?.sells || 0, priceChange: r.all?.[k]?.priceChange ?? null }])),
      win: { window: w, volumeUsd: Math.round(r.x.volumeUsd), swaps: r.x.swaps, buys: r.x.buys, sells: r.x.sells, priceChange: r.x.priceChange, wallets: r.chain?.wallets ?? null, score: +r.s.toFixed(2) },
    }));
  }
  return out;
}

// One combined Trending list: a coin's score is its weighted score across ALL windows (each normalised by that window's best),
// so something exploding right now AND something strong all hour both rank high. Shown with the 1h numbers.
export function combineWindows(windows, weights = { m5: 0.35, h1: 0.35, h6: 0.2, h24: 0.1 }, limit = 80) {
  const total = new Map();
  const entry = new Map();
  for (const w of WINDOWS) {
    const list = windows[w] || [];
    const top = Math.max(...list.map((e) => e.win?.score || 0), 1e-9);
    for (const e of list) {
      total.set(e.mint, (total.get(e.mint) || 0) + weights[w] * ((e.win?.score || 0) / top));
      if (!entry.has(e.mint)) entry.set(e.mint, e);
    }
  }
  return [...entry.values()].sort((a, b) => total.get(b.mint) - total.get(a.mint)).slice(0, limit).map((e) => {
    const h1 = e.allWin?.h1;
    return { ...e, win: { ...e.win, window: 'h1', volumeUsd: h1?.volumeUsd ?? e.win.volumeUsd, swaps: h1?.swaps ?? e.win.swaps, buys: h1?.buys ?? e.win.buys, sells: h1?.sells ?? e.win.sells, priceChange: h1?.priceChange ?? e.win.priceChange } };
  });
}
