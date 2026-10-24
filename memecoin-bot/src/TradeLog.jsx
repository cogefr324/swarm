function formatMC(val) {
  if (!val || val <= 0) return 'N/A';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
  return `$${val.toFixed(0)}`;
}

export default function TradeLog({ position }) {
  const fills = position.fills || [];
  if (fills.length === 0) {
    return (
      <div style={{ marginTop: 12, fontSize: 12, color: '#8296ad' }}>
        No buys or sells yet - waiting for the first trigger.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, color: '#8296ad', marginBottom: 6 }}>
        Trade log ({fills.length} fill{fills.length !== 1 ? 's' : ''}) - check the chart above at these times to see where they landed
      </div>
      <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #223247', borderRadius: 8 }}>
        {[...fills].reverse().map((f) => (
          <div
            key={f.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 10px',
              borderBottom: '1px solid #222',
              fontSize: 12,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: f.type === 'buy' ? '#3ddc97' : '#ff5d6c',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: 10,
                flexShrink: 0,
              }}
            >
              {f.type === 'buy' ? 'B' : 'S'}
            </span>
            <span style={{ color: '#8296ad', width: 70, flexShrink: 0 }}>{new Date(f.t).toLocaleTimeString()}</span>
            <span style={{ fontWeight: 'bold', width: 80, flexShrink: 0 }}>{formatMC(f.marketCap)}</span>
            <span style={{ color: '#8296ad' }}>${f.usdAmount.toFixed(2)} - {f.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Every buy and sell the bot made on one coin - the open position plus any rounds already closed.
// Shown on the coin page, whether you got there from a list, the search bar or your wallet.
export function CoinTradeHistory({ mint, symbol, position, closedTrades }) {
  const rounds = (closedTrades || []).filter((t) => (t.mint || t.coinSnapshot?.mint) === mint);
  const fills = [
    ...(position?.fills || []).map((f) => ({ ...f, open: true })),
    ...rounds.flatMap((t) => (t.fills || []).map((f) => ({ ...f, open: false }))),
  ].sort((a, b) => b.t - a.t);
  if (fills.length === 0) return null;

  const buys = fills.filter((f) => f.type === 'buy').length;
  const sells = fills.length - buys;
  const closedPnl = rounds.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: '#5ec8ff', fontWeight: 'bold', marginBottom: 4 }}>
        Your trades on {symbol}
      </div>
      <div style={{ fontSize: 12, color: '#8296ad', marginBottom: 6 }}>
        {buys} buy{buys !== 1 ? 's' : ''} · {sells} sell{sells !== 1 ? 's' : ''}
        {rounds.length > 0 && (
          <> · closed rounds: {rounds.length} (<span style={{ color: closedPnl >= 0 ? '#3ddc97' : '#ff5d6c' }}>{closedPnl >= 0 ? '+' : ''}${closedPnl.toFixed(2)}</span>)</>
        )}
        {' '}- check the chart above at these times to see where they landed
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid #223247', borderRadius: 8 }}>
        {fills.map((f) => (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '1px solid #222', fontSize: 12 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%',
                background: f.type === 'buy' ? '#3ddc97' : '#ff5d6c', color: '#fff', fontWeight: 'bold', fontSize: 10, flexShrink: 0,
              }}
            >
              {f.type === 'buy' ? 'B' : 'S'}
            </span>
            <span style={{ color: '#8296ad', width: 150, flexShrink: 0 }}>{new Date(f.t).toLocaleString()}</span>
            <span style={{ fontWeight: 'bold', width: 80, flexShrink: 0 }}>{formatMC(f.marketCap)}</span>
            <span style={{ color: '#8296ad' }}>${(f.usdAmount || 0).toFixed(2)} - {f.reason}{f.open ? '' : ' (closed round)'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
