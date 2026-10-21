// Profit & loss maths for the paper account. Everything here is derived from the saved positions and
// closed trades, so it can never drift from what the bot actually did.
export const START_BALANCE = 10000;

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const mintOf = (t) => t.mint || t.coinSnapshot?.mint || String(t.id || '').split('-')[0];

// One row per coin: open position + every closed round, combined.
export function coinPnlRows(positions, closedTrades) {
  const rows = new Map();
  const row = (mint, symbol) => {
    if (!rows.has(mint)) rows.set(mint, { mint, symbol, invested: 0, sold: 0, realized: 0, unrealized: 0, openValue: 0, rounds: 0, open: false, lastT: 0 });
    return rows.get(mint);
  };
  for (const t of closedTrades) {
    const r = row(mintOf(t), t.symbol);
    r.rounds += 1;
    r.realized += t.pnlUsd || 0;
    for (const f of t.fills || []) {
      if (f.type === 'buy') r.invested += f.usdAmount || 0; else r.sold += f.usdAmount || 0;
      r.lastT = Math.max(r.lastT, f.t || 0);
    }
    r.lastT = Math.max(r.lastT, t.closedAt || 0);
  }
  for (const p of positions) {
    const r = row(p.mint, p.symbol);
    r.open = p.tokensHeld > 0 || r.open;
    r.openValue += p.tokensHeld * p.currentPrice;
    r.unrealized += (p.currentPrice - p.avgCostBasis) * p.tokensHeld;
    r.realized += p.realizedPnlUsd || 0;
    for (const f of p.fills || []) {
      if (f.type === 'buy') r.invested += f.usdAmount || 0; else r.sold += f.usdAmount || 0;
      r.lastT = Math.max(r.lastT, f.t || 0);
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, total: r.realized + r.unrealized, pct: r.invested > 0 ? ((r.realized + r.unrealized) / r.invested) * 100 : 0 }))
    .sort((a, b) => b.lastT - a.lastT);
}

export function overallPnl({ balance, positions: rawPositions, closedTrades, livePrices }) {
  // use the freshest known price for every open position
  const positions = rawPositions.map((p) => { const lp = livePrices?.[p.mint]?.priceUsd; return lp > 0 ? { ...p, currentPrice: lp } : p; });
  // cash in the account + money parked in positions (unspent budget + tokens at today's price)
  const parked = sum(positions, (p) => p.availableCash) + sum(positions, (p) => p.tokensHeld * p.currentPrice);
  const equity = balance + parked;
  const rows = coinPnlRows(positions, closedTrades);
  const realized = sum(rows, (r) => r.realized);
  const unrealized = sum(rows, (r) => r.unrealized);
  const wins = closedTrades.filter((t) => (t.pnlUsd || 0) > 0).length;
  const losses = closedTrades.filter((t) => (t.pnlUsd || 0) <= 0).length;
  return {
    equity,
    cash: balance,
    openValue: sum(positions, (p) => p.tokensHeld * p.currentPrice),
    total: equity - START_BALANCE,
    totalPct: ((equity - START_BALANCE) / START_BALANCE) * 100,
    realized,
    unrealized,
    wins,
    losses,
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    rows,
  };
}

export function pnlForMint(mint, positions, closedTrades) {
  return coinPnlRows(positions.filter((p) => p.mint === mint), closedTrades.filter((t) => mintOf(t) === mint))[0] || null;
}
