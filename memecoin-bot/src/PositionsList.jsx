import { usePaperTrading } from './PaperTradingContext';

function formatMC(val, isFdv) {
  if (!val || val <= 0) return 'N/A';
  const suffix = isFdv ? ' (FDV)' : '';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B${suffix}`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M${suffix}`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K${suffix}`;
  return `$${val.toFixed(0)}${suffix}`;
}

export default function PositionsList({ onViewCoin }) {
  const { positions, closePosition } = usePaperTrading();
  const active = positions.filter((p) => p.tokensHeld > 0);

  if (active.length === 0) {
    return (
      <div style={{ maxWidth: '100%', margin: '20px 0', padding: 16, textAlign: 'center', color: '#888', border: '1px solid #2e303a', borderRadius: 8, background: '#17181f' }}>
        No open positions yet. Pick a coin in the Scanning tab to start farming.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '100%', margin: '20px 0', padding: 16, border: '1px solid #2e303a', borderRadius: 8, background: '#17181f', boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px' }}>
      <h3 style={{ marginTop: 0 }}>Open positions</h3>
      <div style={{ maxHeight: 420, overflowY: 'auto', overflowX: 'auto' }}>
<table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #333', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>Coin</th>
            <th style={{ padding: 8 }}>Strategy</th>
            <th style={{ padding: 8 }}>Budget / Available</th>
            <th style={{ padding: 8 }}>Holding Value</th>
            <th style={{ padding: 8 }}>Unrealized</th>
            <th style={{ padding: 8 }}>Realized</th>
            <th style={{ padding: 8 }}>Total PnL</th>
            <th style={{ padding: 8 }}>Fills</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {active.map((pos) => {
            const heldValue = pos.tokensHeld * pos.currentPrice;
            const unrealizedPnl = (pos.currentPrice - pos.avgCostBasis) * pos.tokensHeld;
            const totalPnl = pos.realizedPnlUsd + unrealizedPnl;
            const totalPnlPct = pos.budgetUsd > 0 ? (totalPnl / pos.budgetUsd) * 100 : 0;
            const isGem = pos.strategy === 'gem';
            const nextClip = isGem ? pos.clipLevels?.find((c) => !c.done) : null;

            return (
              <tr
                key={pos.id}
                style={{ borderBottom: '1px solid #222', cursor: 'pointer' }}
                onClick={() => onViewCoin(pos)}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#1f2028')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: 8 }}>{pos.symbol}</td>
                <td style={{ padding: 8, fontSize: 12 }}>
                  {isGem ? (
                    <span style={{ color: '#c084fc' }}>🚀 Gem/Clip{nextClip ? ` (next +${nextClip.pct}%)` : ''}</span>
                  ) : (
                    <span style={{ color: '#888' }}>Farm</span>
                  )}
                </td>
                <td style={{ padding: 8 }}>${pos.budgetUsd.toFixed(2)} / ${pos.availableCash.toFixed(2)}</td>
                <td style={{ padding: 8, fontWeight: 'bold' }}>${heldValue.toFixed(2)}</td>
                <td style={{ padding: 8, color: unrealizedPnl >= 0 ? '#4caf50' : '#f44336' }}>
                  {unrealizedPnl >= 0 ? '+' : '-'}${Math.abs(unrealizedPnl).toFixed(2)}
                  {pos.avgCostBasis > 0 && <span style={{ fontSize: 11 }}> ({unrealizedPnl >= 0 ? '+' : ''}{(((pos.currentPrice - pos.avgCostBasis) / pos.avgCostBasis) * 100).toFixed(1)}%)</span>}
                </td>
                <td style={{ padding: 8, color: pos.realizedPnlUsd >= 0 ? '#4caf50' : '#f44336' }}>
                  {pos.realizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(pos.realizedPnlUsd).toFixed(2)}
                </td>
                <td style={{ padding: 8, color: totalPnl >= 0 ? '#4caf50' : '#f44336', fontWeight: 'bold' }}>
                  {totalPnl >= 0 ? '+' : '-'}${Math.abs(totalPnl).toFixed(2)} <span style={{ fontWeight: 'normal', fontSize: 11 }}>({totalPnlPct.toFixed(1)}%)</span>
                </td>
                <td style={{ padding: 8 }}>{pos.fills.length}</td>
                <td style={{ padding: 8 }}>
                  <button onClick={(e) => { e.stopPropagation(); onViewCoin(pos); }} style={{ marginRight: 6 }}>View</button>
                  <button onClick={(e) => { e.stopPropagation(); closePosition(pos.id); }}>Close</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
</div>
    </div>
  );
}
