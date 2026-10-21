import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchRugCheckSummary } from './rugcheck';
import { getCachedSupply, refreshSupplyIfStale } from './onchainSupply';
import { scanForEarlyGems, setGemVerifyMode } from './earlyGemScanner';
import { api } from './api';

const PaperTradingContext = createContext(null);

const STARTING_BALANCE = 10000;
const PRICE_POLL_INTERVAL_MS = 4000;
const MIN_TRANCHE_USD = 1; // floor to avoid dust trades when a tranche % would be tiny
const GEM_SCAN_INTERVAL_MS = 15000; // v2: scan for early gems every 15s, independent of the farm poll above
const SAVE_DEBOUNCE_MS = 500; // account persistence: wait for state to settle before writing to Supabase

// v2: laddered partial-profit "clipping" schedule for gem positions. Fractions are of the
// ORIGINAL token amount bought at detection, and sum to 1.0 (fully clipped out by +200%).
const CLIP_SCHEDULE = [
  { pct: 50, fraction: 0.25 },
  { pct: 75, fraction: 0.25 },
  { pct: 100, fraction: 0.2 },
  { pct: 150, fraction: 0.15 },
  { pct: 200, fraction: 0.15 },
];

function freshClipLevels() {
  return CLIP_SCHEDULE.map((c) => ({ ...c, done: false }));
}

function defaultState() {
  return {
    balance: STARTING_BALANCE,
    positions: [], // unified: tokensHeld===0 means "analyzed, waiting for first entry"; >0 means active
    closedTrades: [],
    history: [{ t: Date.now(), balance: STARTING_BALANCE }],
    alertedGemMints: [], // v2: mints already popped up as a gem alert, so we don't re-alert them
    settings: {
      stopLossPct: 25, // hard full-close safety net, measured from average cost basis
      dipBuyThresholdPct: 5, // buy trigger: price pulls back this % from the rolling high
      spikeThresholdPct: 8, // buy trigger: price jumps this % within a 5-minute window
      spikeBuyDominanceRatio: 1.5, // buys must outnumber sells by this ratio for a spike to count
      takeProfitPct: 15, // sell trigger: price rises this % from the rolling low since last sell
      trancheBuyPct: 25, // % of remaining available cash to deploy per buy trigger
      trancheSellPct: 25, // % of current token holdings to sell per sell trigger
      minLiquidityUsd: 5000,
      minVolume24hUsd: 5000,
      maxDevHoldingPct: 15,
      maxTop10HoldingPct: 70,
      gemAutoBuyEnabled: false, // v2: when on, detected gems are bought automatically
      gemVerifyDryRun: false, // true = the copycat/scam filter only logs, never blocks
      gemStopLossPct: 30, // gem positions fully close if they fall this far below entry
      gemMaxOpen: 5, // max gem positions open at once
      gemAutoBuyAmountUsd: 50, // v2: $ spent immediately per detected gem
    },
  };
}

// Repairs a saved position rather than discarding it outright - fills in any missing/invalid
// field with a safe default so a partially-corrupted save (e.g. from an older app version)
// can't crash the UI with "reading toFixed of undefined" type errors. Only drops a position
// entirely if it's missing the bare minimum to identify what coin it even was.
function sanitizePosition(p) {
  if (!p || typeof p !== 'object' || !p.mint || !p.symbol) return null;
  const num = (v, fallback = 0) => (typeof v === 'number' && !Number.isNaN(v) ? v : fallback);
  return {
    id: p.id || `${p.mint}-${Date.now()}`,
    mint: p.mint,
    pairAddress: p.pairAddress || '',
    symbol: p.symbol,
    name: p.name || p.symbol,
    strategy: p.strategy === 'gem' ? 'gem' : 'farm', // v2: 'gem' = clip-mode position, otherwise the original tranche farm
    coinSnapshot: p.coinSnapshot && typeof p.coinSnapshot === 'object' ? p.coinSnapshot : null,
    budgetUsd: num(p.budgetUsd),
    availableCash: num(p.availableCash),
    tokensHeld: num(p.tokensHeld),
    originalTokensHeld: num(p.originalTokensHeld, num(p.tokensHeld)), // v2: used by gem clip math, unused by farm positions
    clipLevels: Array.isArray(p.clipLevels) ? p.clipLevels : freshClipLevels(), // v2
    avgCostBasis: num(p.avgCostBasis),
    realizedPnlUsd: num(p.realizedPnlUsd),
    fills: Array.isArray(p.fills) ? p.fills : [],
    referenceHigh: num(p.referenceHigh, num(p.currentPrice, 0)),
    referenceLow: typeof p.referenceLow === 'number' ? p.referenceLow : null,
    currentPrice: num(p.currentPrice),
    currentMarketCap: num(p.currentMarketCap),
    currentMarketCapIsFdv: !!p.currentMarketCapIsFdv,
    priceHistory: Array.isArray(p.priceHistory) ? p.priceHistory : [],
    openedAt: num(p.openedAt, Date.now()),
  };
}

// Repairs/validates a whole saved state blob the same defensive way sanitizePosition repairs a
// single position - used when loading a row back from Supabase, so a partially-corrupted or
// older-shape save can't crash the UI. Falls back to a clean slate on anything unexpected.
function sanitizeState(parsed) {
  const fallback = defaultState();
  try {
    if (!parsed || typeof parsed !== 'object') return fallback;

    const positions = Array.isArray(parsed.positions) ? parsed.positions.map(sanitizePosition).filter(Boolean) : [];
    const closedTrades = Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [];
    const history = Array.isArray(parsed.history) && parsed.history.length > 0 ? parsed.history : fallback.history;
    const balance = typeof parsed.balance === 'number' && !Number.isNaN(parsed.balance) ? parsed.balance : fallback.balance;
    const alertedGemMints = Array.isArray(parsed.alertedGemMints) ? parsed.alertedGemMints : [];
    const settings = { ...fallback.settings, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) };

    return { balance, positions, closedTrades, history, alertedGemMints, settings };
  } catch (e) {
    // corrupted/unexpected shape - fall back to a clean slate rather than crashing
    return fallback;
  }
}

function analyzeCoin(coin, settings, rugCheck) {
  const reasons = [];
  const warnings = [];

  if (coin.liquidityUsd < settings.minLiquidityUsd) {
    reasons.push(`Liquidity too low: $${coin.liquidityUsd.toLocaleString('en-US')} (minimum $${settings.minLiquidityUsd.toLocaleString('en-US')})`);
  }
  if (coin.volume24h < settings.minVolume24hUsd) {
    reasons.push(`24h volume too low: $${coin.volume24h.toLocaleString('en-US')} (minimum $${settings.minVolume24hUsd.toLocaleString('en-US')})`);
  }
  if (coin.liquidityUsd > 0 && coin.volume24h / coin.liquidityUsd < 0.05) {
    warnings.push('Very low trading volume relative to liquidity - activity looks thin.');
  }

  const txns24h = coin.txns?.h24;
  if (txns24h && (txns24h.buys + txns24h.sells) > 0) {
    const totalTxns = txns24h.buys + txns24h.sells;
    const sellShare = txns24h.sells / totalTxns;
    if (sellShare > 0.65) {
      warnings.push(`Sell-heavy: ${txns24h.sells} sells vs ${txns24h.buys} buys in 24h - could indicate distribution/dumping.`);
    }
  }

  if (coin.priceChange24h <= -50) {
    warnings.push('Down over 50% in the last 24h - could be a real dip opportunity or a dying/rugged coin. Proceed with caution.');
  }

  if (rugCheck) {
    if (rugCheck.rugged) reasons.push('RugCheck flags this token as already rugged.');
    if (rugCheck.mintAuthorityActive) reasons.push('Mint authority is still active - the dev can mint unlimited new supply.');
    if (rugCheck.freezeAuthorityActive) reasons.push('Freeze authority is still active - the dev could freeze holder wallets.');
    if (rugCheck.devPct !== null && rugCheck.devPct > settings.maxDevHoldingPct) {
      reasons.push(`Dev wallet holds ${rugCheck.devPct.toFixed(1)}% of supply (max allowed ${settings.maxDevHoldingPct}%).`);
    }
    if (rugCheck.top10Pct !== null && rugCheck.top10Pct > settings.maxTop10HoldingPct) {
      reasons.push(`Top 10 holders control ${rugCheck.top10Pct.toFixed(1)}% of supply (max allowed ${settings.maxTop10HoldingPct}%) - concentrated/bundled distribution risk.`);
    }
    if (rugCheck.insiderCount > 0) {
      warnings.push(`RugCheck detected ${rugCheck.insiderCount} connected/insider wallet network(s) - possible hidden bundle.`);
    }
    for (const risk of rugCheck.risks) {
      if (risk.level === 'danger') warnings.push(`RugCheck: ${risk.name}${risk.description ? ' - ' + risk.description : ''}`);
    }
  } else {
    warnings.push('RugCheck data unavailable for this token - holder/bundle risk could not be checked.');
  }

  return { passed: reasons.length === 0, reasons, warnings };
}

// The core scaling-in/scaling-out engine, run once per poll tick per position. Pure function -
// takes the position and fresh market data, returns what should happen. Never buys/sells the
// full budget/holdings at once - only a tranche - and keeps cycling until stop-loss or a
// manual close.
function computeTick(pos, priceUsd, exactMarketCap, isFdv, m5Change, m5Txns, settings) {
  // Circuit breaker: a single API tick reporting a >90% drop or >10x jump versus the last
  // known price is almost certainly a glitched/bad data point, not a real memecoin move - acting
  // on it (buying/selling using that price) would corrupt the position's token math permanently,
  // since tokensBought = dollarsSpent / price. Skip the tick entirely rather than trust it.
  if (pos.currentPrice > 0) {
    const ratio = priceUsd / pos.currentPrice;
    if (ratio < 0.1 || ratio > 10) {
      return { type: 'update', position: pos };
    }
  }

  const nextHistory = [...(pos.priceHistory || []), { t: Date.now(), price: priceUsd, marketCap: exactMarketCap }].slice(-300);

  // Hard stop-loss - the only automatic FULL close, measured from average cost basis.
  if (pos.tokensHeld > 0 && pos.avgCostBasis > 0) {
    const unrealizedPct = ((priceUsd - pos.avgCostBasis) / pos.avgCostBasis) * 100;
    if (unrealizedPct <= -settings.stopLossPct) {
      return { type: 'close', priceUsd, exactMarketCap, reason: `stop-loss: ${unrealizedPct.toFixed(1)}% from avg cost` };
    }
  }

  const referenceHigh = Math.max(pos.referenceHigh, priceUsd);
  const referenceLow = pos.referenceLow !== null ? Math.min(pos.referenceLow, priceUsd) : null;

  const drawdownPct = ((referenceHigh - priceUsd) / referenceHigh) * 100;
  const dipHit = drawdownPct >= settings.dipBuyThresholdPct;

  const buyDominance = m5Txns.sells > 0 ? m5Txns.buys / m5Txns.sells : m5Txns.buys > 0 ? Infinity : 0;
  const spikeHit = m5Change >= settings.spikeThresholdPct && buyDominance >= settings.spikeBuyDominanceRatio;

  const pumpPct = referenceLow !== null ? ((priceUsd - referenceLow) / referenceLow) * 100 : 0;
  const pumpHit = pos.tokensHeld > 0 && referenceLow !== null && pumpPct >= settings.takeProfitPct;

  const canBuy = pos.availableCash > MIN_TRANCHE_USD;
  const canSell = pos.tokensHeld * priceUsd > MIN_TRANCHE_USD;

  const base = { referenceHigh, referenceLow: referenceLow ?? priceUsd, currentPrice: priceUsd, currentMarketCap: exactMarketCap, currentMarketCapIsFdv: isFdv, priceHistory: nextHistory };

  if ((dipHit || spikeHit) && canBuy) {
    let usdToSpend = pos.availableCash * (settings.trancheBuyPct / 100);
    if (usdToSpend < MIN_TRANCHE_USD) usdToSpend = pos.availableCash; // deploy the remainder rather than firing dust trades
    usdToSpend = Math.min(usdToSpend, pos.availableCash);

    const tokensBought = usdToSpend / priceUsd;
    const newTokensHeld = pos.tokensHeld + tokensBought;
    const newAvgCost = (pos.avgCostBasis * pos.tokensHeld + usdToSpend) / newTokensHeld;
    const fill = {
      id: `${Date.now()}-buy-${Math.random().toString(36).slice(2, 7)}`,
      type: 'buy',
      price: priceUsd,
      marketCap: exactMarketCap,
      tokens: tokensBought,
      usdAmount: usdToSpend,
      reason: dipHit ? `dip: -${drawdownPct.toFixed(1)}% from high` : `spike: +${m5Change.toFixed(1)}% in 5m`,
      t: Date.now(),
    };
    return {
      type: 'update',
      position: {
        ...pos,
        ...base,
        availableCash: pos.availableCash - usdToSpend,
        tokensHeld: newTokensHeld,
        avgCostBasis: newAvgCost,
        fills: [...pos.fills, fill].slice(-150),
        referenceHigh: priceUsd, // require a fresh pullback before the next buy
      },
    };
  }

  if (pumpHit && canSell) {
    let tokensToSell = pos.tokensHeld * (settings.trancheSellPct / 100);
    if (tokensToSell * priceUsd < MIN_TRANCHE_USD) tokensToSell = pos.tokensHeld;
    tokensToSell = Math.min(tokensToSell, pos.tokensHeld);

    const proceeds = tokensToSell * priceUsd;
    const realizedGain = (priceUsd - pos.avgCostBasis) * tokensToSell;
    const fill = {
      id: `${Date.now()}-sell-${Math.random().toString(36).slice(2, 7)}`,
      type: 'sell',
      price: priceUsd,
      marketCap: exactMarketCap,
      tokens: tokensToSell,
      usdAmount: proceeds,
      reason: `pump: +${pumpPct.toFixed(1)}% from low`,
      t: Date.now(),
    };
    return {
      type: 'update',
      position: {
        ...pos,
        ...base,
        availableCash: pos.availableCash + proceeds,
        tokensHeld: pos.tokensHeld - tokensToSell,
        realizedPnlUsd: pos.realizedPnlUsd + realizedGain,
        fills: [...pos.fills, fill].slice(-150),
        referenceLow: priceUsd, // require a fresh pump before the next sell
      },
    };
  }

  return { type: 'update', position: { ...pos, ...base } };
}

export function PaperTradingProvider({ children, userId }) {
  const [state, setState] = useState(defaultState);
  const [loaded, setLoaded] = useState(false); // becomes true once this user's row has been fetched (or found absent) - gates saving, so we never overwrite a remote row with fresh-mount defaults
  const [livePrices, setLivePrices] = useState({}); // { [mint]: { priceUsd, marketCap, isFdv } } - not persisted, just a live cache
  const [viewingCoin, setViewingCoin] = useState(null); // { mint, pairAddress } | null
  const [gemAlerts, setGemAlerts] = useState([]); // v2: ephemeral popup queue, not persisted
  const pollRef = useRef(null);
  const gemScanRef = useRef(null);
  const saveTimerRef = useRef(null);
  const stateRef = useRef(state); // lets closures (scan-loop, setTimeout callbacks) always read the latest state
  stateRef.current = state;

  // Load this account's saved trading state from our own server whenever the signed-in user changes.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    if (!userId) return;

    (async () => {
      try {
        const remoteState = await api.getState();
        if (cancelled) return;
        setState(remoteState ? sanitizeState(remoteState) : defaultState());
      } catch (e) {
        if (!cancelled) setState(defaultState());
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Debounced save: wait for state to settle before writing, so rapid-fire ticks (price polls,
  // several tranche fills in a row) don't fire a request on every single update. Gated on
  // `loaded` so we never overwrite the saved state with the pre-load default state.
  useEffect(() => {
    if (!loaded || !userId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.saveState(state).catch((e) => console.error('Failed to save trading state:', e.message));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
  }, [state, loaded, userId]);

  function addHistoryPoint(balance) {
    setState((s) => ({ ...s, history: [...s.history.slice(-200), { t: Date.now(), balance }] }));
  }

  function updateSettings(newSettings) {
    setState((s) => ({ ...s, settings: { ...s.settings, ...newSettings } }));
  }

  // Start farming: carve `budgetUsd` out of the global paper balance into a dedicated
  // allocation for this coin. Runs analysis (incl. RugCheck) first; if it passes, the position
  // starts with $0 deployed, waiting for the first dip/spike trigger to make its first tranche buy.
  async function startFarming(coin, budgetUsd) {
    const rugCheck = await fetchRugCheckSummary(coin.mint);
    const analysis = analyzeCoin(coin, state.settings, rugCheck);
    if (analysis.passed) {
      setState((s) => {
        if (budgetUsd <= 0 || budgetUsd > s.balance) return s;
        if (s.positions.some((p) => p.mint === coin.mint)) return s; // already have an open position in this coin
        const mc = coin.marketCap || coin.fdv || 0;
        const newPosition = {
          id: `${coin.mint}-${Date.now()}`,
          mint: coin.mint,
          pairAddress: coin.pairAddress || '',
          symbol: coin.symbol,
          name: coin.name,
          strategy: 'farm',
          coinSnapshot: coin,
          budgetUsd,
          availableCash: budgetUsd,
          tokensHeld: 0,
          originalTokensHeld: 0,
          clipLevels: freshClipLevels(),
          avgCostBasis: 0,
          realizedPnlUsd: 0,
          fills: [],
          referenceHigh: coin.priceUsd,
          referenceLow: null,
          currentPrice: coin.priceUsd,
          currentMarketCap: mc,
          currentMarketCapIsFdv: coin.marketCapIsFdv || false,
          priceHistory: [{ t: Date.now(), price: coin.priceUsd, marketCap: mc }],
          openedAt: Date.now(),
        };
        return {
          ...s,
          balance: s.balance - budgetUsd,
          positions: [...s.positions.filter((p) => p.mint !== coin.mint), newPosition],
        };
      });
      setTimeout(() => addHistoryPoint(stateRef.current.balance), 0);
    }
    return analysis;
  }

  // Manual override: skip analysis and the wait-for-a-trigger step, but still only buys the
  // amount the user chooses (buyAmountUsd) - never the full budget automatically. If this coin
  // isn't being farmed yet, budgetUsd allocates a new farm first; either way, only buyAmountUsd
  // of it gets spent right now, and the rest sits as availableCash for future tranche buys.
  function buyNowSkipAnalysis(coin, budgetUsd, buyAmountUsd) {
    setState((s) => {
      let pos = s.positions.find((p) => p.mint === coin.mint);
      let positions = s.positions;
      let newBalance = s.balance;

      if (!pos) {
        if (budgetUsd <= 0 || budgetUsd > s.balance) return s;
        const mc = coin.marketCap || coin.fdv || 0;
        pos = {
          id: `${coin.mint}-${Date.now()}`,
          mint: coin.mint,
          pairAddress: coin.pairAddress || '',
          symbol: coin.symbol,
          name: coin.name,
          strategy: 'farm',
          coinSnapshot: coin,
          budgetUsd,
          availableCash: budgetUsd,
          tokensHeld: 0,
          originalTokensHeld: 0,
          clipLevels: freshClipLevels(),
          avgCostBasis: 0,
          realizedPnlUsd: 0,
          fills: [],
          referenceHigh: coin.priceUsd,
          referenceLow: null,
          currentPrice: coin.priceUsd,
          currentMarketCap: mc,
          currentMarketCapIsFdv: coin.marketCapIsFdv || false,
          priceHistory: [{ t: Date.now(), price: coin.priceUsd, marketCap: mc }],
          openedAt: Date.now(),
        };
        newBalance = s.balance - budgetUsd;
        positions = [...s.positions, pos];
      }

      const spendAmount = Math.min(Math.max(buyAmountUsd || 0, 0), pos.availableCash);
      if (spendAmount <= 0) {
        return { ...s, balance: newBalance, positions };
      }

      const tokensBought = spendAmount / pos.currentPrice;
      const newTokensHeld = pos.tokensHeld + tokensBought;
      const newAvgCost = (pos.avgCostBasis * pos.tokensHeld + spendAmount) / newTokensHeld;
      const fill = {
        id: `${Date.now()}-buy-manual`,
        type: 'buy',
        price: pos.currentPrice,
        marketCap: pos.currentMarketCap,
        tokens: tokensBought,
        usdAmount: spendAmount,
        reason: 'manual buy',
        t: Date.now(),
      };
      const updatedPos = {
        ...pos,
        availableCash: pos.availableCash - spendAmount,
        tokensHeld: newTokensHeld,
        avgCostBasis: newAvgCost,
        fills: [...pos.fills, fill],
      };

      return {
        ...s,
        balance: newBalance,
        positions: positions.map((p) => (p.id === updatedPos.id ? updatedPos : p)),
      };
    });
    setTimeout(() => addHistoryPoint(stateRef.current.balance), 0);
  }

  // v2: Early-gem "clipping" strategy - buys the FULL chosen amount immediately on detection
  // (no dip-waiting, unlike the farm positions above), then takes profit automatically in
  // slices as gain crosses +50% / +75% / +100% / +150% / +200%.
  function buyGemPosition(coin, usdAmount) {
    setState((s) => {
      if (usdAmount <= 0 || usdAmount > s.balance) return s;
      if (s.positions.some((p) => p.mint === coin.mint)) return s; // already holding it - never buy the same coin twice
      const tokensBought = usdAmount / coin.priceUsd;
      const mc = coin.marketCap || coin.fdv || 0;
      // CoinDetailPanel expects a full coin shape (liquidityUsd, volume24h, txns, etc. all as
      // real values, not undefined) whenever it renders coinSnapshot - the gem alert only carries
      // a subset of those fields, so fill in every field it reads with a safe default here rather
      // than storing the alert object as-is.
      const fullCoinSnapshot = {
        mint: coin.mint,
        pairAddress: coin.pairAddress || '',
        symbol: coin.symbol,
        name: coin.name || coin.symbol,
        priceUsd: coin.priceUsd,
        liquidityUsd: coin.liquidityUsd || 0,
        volume24h: coin.volume24h || 0,
        priceChange24h: coin.priceChange24h || 0,
        priceChange: coin.priceChange || { m5: 0, h1: 0, h6: 0, h24: coin.priceChange24h || 0 },
        txns: coin.txns || { h24: { buys: 0, sells: 0 } },
        pairCreatedAt: coin.pairCreatedAt || null,
        marketCap: mc,
        marketCapIsFdv: coin.marketCapIsFdv ?? !coin.marketCap,
        iconUrl: coin.iconUrl || null,
        dexUrl: coin.dexUrl || null,
      };
      const newPosition = {
        id: `${coin.mint}-${Date.now()}`,
        mint: coin.mint,
        pairAddress: coin.pairAddress || '',
        symbol: coin.symbol,
        name: coin.name || coin.symbol,
        strategy: 'gem',
        coinSnapshot: fullCoinSnapshot,
        budgetUsd: usdAmount,
        availableCash: 0, // fully deployed immediately - nothing held back for later tranches
        tokensHeld: tokensBought,
        originalTokensHeld: tokensBought,
        clipLevels: freshClipLevels(),
        avgCostBasis: coin.priceUsd,
        realizedPnlUsd: 0,
        fills: [
          {
            id: `${Date.now()}-buy-gem`,
            type: 'buy',
            price: coin.priceUsd,
            marketCap: mc,
            tokens: tokensBought,
            usdAmount,
            reason: 'early gem detection (immediate buy)',
            t: Date.now(),
          },
        ],
        referenceHigh: coin.priceUsd,
        referenceLow: coin.priceUsd,
        currentPrice: coin.priceUsd,
        currentMarketCap: mc,
        currentMarketCapIsFdv: !coin.marketCap,
        priceHistory: [{ t: Date.now(), price: coin.priceUsd, marketCap: mc }],
        openedAt: Date.now(),
      };
      return { ...s, balance: s.balance - usdAmount, positions: [...s.positions, newPosition] };
    });
    setTimeout(() => addHistoryPoint(stateRef.current.balance), 0);
  }

  // Manual full close (or the internal call used by auto stop-loss): sells any remaining
  // tokens at the given price, returns availableCash + proceeds to the global balance.
  function closePosition(positionId, priceOverride, reasonOverride) {
    setState((s) => {
      const pos = s.positions.find((p) => p.id === positionId);
      if (!pos) return s;
      const exitPrice = priceOverride ?? pos.currentPrice;
      const proceeds = pos.tokensHeld * exitPrice;
      const finalRealizedPnl = pos.realizedPnlUsd + (pos.tokensHeld > 0 ? (exitPrice - pos.avgCostBasis) * pos.tokensHeld : 0);
      const returnedToBalance = pos.availableCash + proceeds;

      const closedTrade = {
        id: pos.id,
        mint: pos.mint,
        symbol: pos.symbol,
        budgetUsd: pos.budgetUsd,
        avgCostBasis: pos.avgCostBasis,
        exitPrice,
        pnlUsd: finalRealizedPnl,
        pnlPct: pos.budgetUsd > 0 ? (finalRealizedPnl / pos.budgetUsd) * 100 : 0,
        reason: reasonOverride || 'manual close',
        fillCount: pos.fills.length,
        closedAt: Date.now(),
        openedAt: pos.openedAt,
        priceHistory: pos.priceHistory,
        fills: pos.fills,
        coinSnapshot: pos.coinSnapshot,
      };

      const newBalance = s.balance + returnedToBalance;
      return {
        ...s,
        balance: newBalance,
        positions: s.positions.filter((p) => p.id !== positionId),
        closedTrades: [...s.closedTrades, closedTrade],
        history: [...s.history.slice(-200), { t: Date.now(), balance: newBalance }],
      };
    });
  }

  function applyTick(mint, priceUsd, exactMarketCap, isFdv, m5Change, m5Txns) {
    setState((s) => {
      const pos = s.positions.find((p) => p.mint === mint);
      if (!pos) return s;
      const result = computeTick(pos, priceUsd, exactMarketCap, isFdv, m5Change, m5Txns, s.settings);
      if (result.type === 'close') {
        setTimeout(() => closePosition(pos.id, result.priceUsd, result.reason), 0);
        return s;
      }
      return { ...s, positions: s.positions.map((p) => (p.id === pos.id ? result.position : p)) };
    });
  }

  // v2: Separate tick path for 'gem' strategy positions - no dip/spike/pump logic, just the
  // laddered clip-sell schedule. Fully self-contained (atomic setState) so it never races with
  // the farm tick above.
  function applyGemTick(mint, priceUsd, exactMarketCap, isFdv) {
    setState((s) => {
      const pos = s.positions.find((p) => p.mint === mint && p.strategy === 'gem');
      if (!pos) return s;

      // Same circuit breaker as the farm engine - ignore an obviously glitched price tick.
      if (pos.currentPrice > 0) {
        const ratio = priceUsd / pos.currentPrice;
        if (ratio < 0.1 || ratio > 10) return s;
      }

      const nextHistory = [...(pos.priceHistory || []), { t: Date.now(), price: priceUsd, marketCap: exactMarketCap }].slice(-300);
      const changePct = pos.avgCostBasis > 0 ? ((priceUsd - pos.avgCostBasis) / pos.avgCostBasis) * 100 : 0;
      const levels = pos.clipLevels && pos.clipLevels.length ? pos.clipLevels : freshClipLevels();
      // Stop loss for gem positions: sell everything left once price is this far below entry.
      const gemStop = Number(s.settings.gemStopLossPct ?? 30);
      if (gemStop > 0 && pos.avgCostBasis > 0 && changePct <= -gemStop) {
        const proceeds = pos.tokensHeld * priceUsd;
        const finalPnl = pos.realizedPnlUsd + (priceUsd - pos.avgCostBasis) * pos.tokensHeld;
        const stopFill = { id: `${Date.now()}-gem-stop`, type: 'sell', price: priceUsd, marketCap: exactMarketCap, tokens: pos.tokensHeld, usdAmount: proceeds, reason: `stop loss (${changePct.toFixed(0)}% from entry)`, t: Date.now() };
        const newBal = s.balance + pos.availableCash + proceeds;
        return {
          ...s,
          balance: newBal,
          positions: s.positions.filter((p) => p.id !== pos.id),
          closedTrades: [...s.closedTrades, {
            id: pos.id, mint: pos.mint, symbol: pos.symbol, budgetUsd: pos.budgetUsd, avgCostBasis: pos.avgCostBasis, exitPrice: priceUsd,
            pnlUsd: finalPnl, pnlPct: pos.budgetUsd > 0 ? (finalPnl / pos.budgetUsd) * 100 : 0,
            reason: `stop loss (${changePct.toFixed(0)}% from entry)`, fillCount: pos.fills.length + 1, closedAt: Date.now(), openedAt: pos.openedAt,
            priceHistory: nextHistory, fills: [...pos.fills, stopFill], coinSnapshot: pos.coinSnapshot,
          }],
          history: [...s.history.slice(-200), { t: Date.now(), balance: newBal }],
        };
      }
      const nextLevel = levels.find((l) => !l.done && changePct >= l.pct);

      if (!nextLevel) {
        return {
          ...s,
          positions: s.positions.map((p) =>
            p.id === pos.id
              ? { ...p, currentPrice: priceUsd, currentMarketCap: exactMarketCap, currentMarketCapIsFdv: isFdv, priceHistory: nextHistory }
              : p
          ),
        };
      }

      const tokensToSell = Math.min(pos.originalTokensHeld * nextLevel.fraction, pos.tokensHeld);
      const proceeds = tokensToSell * priceUsd;
      const realizedGain = (priceUsd - pos.avgCostBasis) * tokensToSell;
      const fill = {
        id: `${Date.now()}-clip-${nextLevel.pct}`,
        type: 'sell',
        price: priceUsd,
        marketCap: exactMarketCap,
        tokens: tokensToSell,
        usdAmount: proceeds,
        reason: `clip +${nextLevel.pct}% (${(nextLevel.fraction * 100).toFixed(0)}% of position)`,
        t: Date.now(),
      };
      const updatedLevels = levels.map((l) => (l.pct === nextLevel.pct ? { ...l, done: true } : l));
      const newTokensHeld = pos.tokensHeld - tokensToSell;
      const allDone = updatedLevels.every((l) => l.done) || newTokensHeld <= 1e-9;

      if (allDone) {
        const finalRealizedPnl = pos.realizedPnlUsd + realizedGain;
        const returnedToBalance = pos.availableCash + proceeds; // availableCash is 0 for gem positions - everything deployed at entry
        const closedTrade = {
          id: pos.id,
          mint: pos.mint,
          symbol: pos.symbol,
          budgetUsd: pos.budgetUsd,
          avgCostBasis: pos.avgCostBasis,
          exitPrice: priceUsd,
          pnlUsd: finalRealizedPnl,
          pnlPct: pos.budgetUsd > 0 ? (finalRealizedPnl / pos.budgetUsd) * 100 : 0,
          reason: `fully clipped out (last clip +${nextLevel.pct}%)`,
          fillCount: pos.fills.length + 1,
          closedAt: Date.now(),
          openedAt: pos.openedAt,
          priceHistory: nextHistory,
          fills: [...pos.fills, fill],
          coinSnapshot: pos.coinSnapshot,
        };
        const newBalance = s.balance + returnedToBalance;
        return {
          ...s,
          balance: newBalance,
          positions: s.positions.filter((p) => p.id !== pos.id),
          closedTrades: [...s.closedTrades, closedTrade],
          history: [...s.history.slice(-200), { t: Date.now(), balance: newBalance }],
        };
      }

      return {
        ...s,
        positions: s.positions.map((p) =>
          p.id === pos.id
            ? {
                ...p,
                tokensHeld: newTokensHeld,
                realizedPnlUsd: p.realizedPnlUsd + realizedGain,
                clipLevels: updatedLevels,
                fills: [...p.fills, fill].slice(-150),
                currentPrice: priceUsd,
                currentMarketCap: exactMarketCap,
                currentMarketCapIsFdv: isFdv,
                priceHistory: nextHistory,
              }
            : p
        ),
      };
    });
  }

  function resetPaperAccount() {
    setState({
      balance: STARTING_BALANCE,
      positions: [],
      closedTrades: [],
      history: [{ t: Date.now(), balance: STARTING_BALANCE }],
      alertedGemMints: [],
      settings: state.settings,
    });
  }

  // v2: dismiss a popup without buying
  function dismissGemAlert(mint) {
    setGemAlerts((alerts) => alerts.filter((a) => a.mint !== mint));
  }

  // v2: manual "Buy Now (Clip Mode)" from the popup, using the configured gem auto-buy amount
  function buyGemFromAlert(alert) {
    // Pass the whole alert through - it already carries liquidityUsd/volume24h/txns/iconUrl/etc.
    // from the scanner, so the resulting position's coin detail view has real data, not zeros.
    buyGemPosition(alert, state.settings.gemAutoBuyAmountUsd);
    dismissGemAlert(alert.mint);
  }

  useEffect(() => {
    async function sync() {
      const posItems = state.positions.map((p) => ({ mint: p.mint, pair: p.pairAddress }));
      const viewItems = viewingCoin ? [{ mint: viewingCoin.mint, pair: viewingCoin.pairAddress }] : [];
      const allItems = [...posItems, ...viewItems];
      if (allItems.length === 0) return;

      const uniqueByMint = new Map();
      for (const item of allItems) if (!uniqueByMint.has(item.mint)) uniqueByMint.set(item.mint, item);
      const items = [...uniqueByMint.values()];

      // Kick off (throttled) on-chain supply refreshes - fire and forget, used once resolved
      for (const { mint } of items) refreshSupplyIfStale(mint);

      const pairAddresses = [...new Set(items.map((i) => i.pair).filter(Boolean))];
      const mintAddresses = items.map((i) => i.mint);

      try {
        // DexScreener answers at most 30 addresses per call, so a bigger portfolio has to be split up.
        // (Before, anything past the first 30 positions - or any coin the pair lookup missed - never got a
        // price update, so it sat at 0.0% and the overall PnL looked like it ignored open positions.)
        const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
        const getJ = async (url) => { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } };
        let pairsData = [];
        const byPair = await Promise.all(chunk(pairAddresses, 30).map((c) => getJ(`https://api.dexscreener.com/latest/dex/pairs/solana/${c.join(',')}`)));
        for (const j of byPair) if (j?.pairs) pairsData.push(...j.pairs);
        const have = new Set(pairsData.map((p) => p.baseToken?.address));
        const missing = mintAddresses.filter((m) => !have.has(m));
        const byMint = await Promise.all(chunk(missing, 30).map((c) => getJ(`https://api.dexscreener.com/latest/dex/tokens/${c.join(',')}`)));
        for (const j of byMint) if (j?.pairs) pairsData.push(...j.pairs.filter((p) => p.chainId === 'solana'));

        const liveUpdates = {};
        for (const { mint, pair } of items) {
          const matched = pairsData.find((p) => p.pairAddress === pair) || pairsData.find((p) => p.baseToken?.address === mint);
          if (!matched) continue;
          const priceUsd = parseFloat(matched.priceUsd);
          if (!(priceUsd > 0)) continue;

          // Prefer our own on-chain-supply-based MC (burn-aware, always accurate) over
          // DexScreener's cached fields once we have it cached for this mint.
          const onChainSupply = getCachedSupply(mint);
          const exactMarketCap = onChainSupply ? priceUsd * onChainSupply : matched.marketCap || matched.fdv || 0;
          const isFdv = onChainSupply ? false : !matched.marketCap;

          const m5Change = matched.priceChange?.m5 || 0;
          const m5Txns = matched.txns?.m5 || { buys: 0, sells: 0 };

          liveUpdates[mint] = { priceUsd, marketCap: exactMarketCap, isFdv };

          // v2: gem positions use the clip-sell tick, everything else uses the original
          // dip/spike/pump tranche engine.
          const posForMint = stateRef.current.positions.find((p) => p.mint === mint);
          if (posForMint && posForMint.strategy === 'gem') {
            applyGemTick(mint, priceUsd, exactMarketCap, isFdv);
          } else {
            applyTick(mint, priceUsd, exactMarketCap, isFdv, m5Change, m5Txns);
          }
        }
        if (Object.keys(liveUpdates).length > 0) {
          setLivePrices((prev) => ({ ...prev, ...liveUpdates }));
        }
      } catch (e) {
        // network hiccup - skip this cycle, next poll will retry
      }
    }

    pollRef.current = setInterval(sync, PRICE_POLL_INTERVAL_MS);
    sync();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.positions.length, viewingCoin?.mint]);

  useEffect(() => { setGemVerifyMode(state.settings.gemVerifyDryRun ? 'dry-run' : 'enforce'); }, [state.settings.gemVerifyDryRun]);

  // v2: Early-gem scanning loop - runs independently of the farm poll above, on its own timer.
  useEffect(() => {
    // Wait until the saved account state has loaded. Before, the scan started on the empty default
    // state, so after every refresh it re-found coins it had already bought and bought them again.
    if (!loaded || !userId) return undefined;
    async function runScan() {
      // never re-alert / re-buy anything already alerted OR currently held (survives refresh/restart)
      const alertedSet = new Set([...(stateRef.current.alertedGemMints || []), ...stateRef.current.positions.map((p) => p.mint)]);
      const foundAll = await scanForEarlyGems(alertedSet);
      const held = new Set(stateRef.current.positions.map((p) => p.mint));
      const already = new Set(stateRef.current.alertedGemMints || []);
      const found = foundAll.filter((f) => !held.has(f.mint) && !already.has(f.mint));
      if (found.length === 0) return;

      setState((s) => ({
        ...s,
        alertedGemMints: [...(s.alertedGemMints || []), ...found.map((f) => f.mint)].slice(-500),
      }));

      const settingsNow = stateRef.current.settings;
      if (settingsNow.gemAutoBuyEnabled) {
        // cap: never more than gemMaxOpen gem positions open, and at most 2 new buys per scan
        const openGems = stateRef.current.positions.filter((p) => p.strategy === 'gem').length;
        const room = Math.max(0, (settingsNow.gemMaxOpen ?? 5) - openGems);
        found.slice(0, Math.min(2, room)).forEach((alert) => {
          buyGemPosition(alert, settingsNow.gemAutoBuyAmountUsd);
        });
      }
      // Still show the popup either way, so the user can see what the bot found (and what it
      // bought, if auto-buy is on) - just can't manually buy again from it when auto-buy already did.
      // Dedupe by mint: in dev, React's StrictMode double-invokes this effect on mount, which can
      // otherwise queue the same alert twice in the same tick (duplicate React keys, duplicate popups).
      setGemAlerts((prev) => {
        const seen = new Set();
        return [...found, ...prev].filter((a) => (seen.has(a.mint) ? false : (seen.add(a.mint), true))).slice(0, 10);
      });
    }

    gemScanRef.current = setInterval(runScan, GEM_SCAN_INTERVAL_MS);
    runScan();

    return () => clearInterval(gemScanRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, userId]);

  const value = {
    balance: state.balance,
    positions: state.positions,
    closedTrades: state.closedTrades,
    history: state.history,
    settings: state.settings,
    livePrices,
    gemAlerts,
    setViewingCoin,
    startFarming,
    buyNowSkipAnalysis,
    closePosition,
    updateSettings,
    resetPaperAccount,
    dismissGemAlert,
    buyGemFromAlert,
  };

  return <PaperTradingContext.Provider value={value}>{children}</PaperTradingContext.Provider>;
}

export function usePaperTrading() {
  const ctx = useContext(PaperTradingContext);
  if (!ctx) throw new Error('usePaperTrading must be used inside PaperTradingProvider');
  return ctx;
}
