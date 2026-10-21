import { usePaperTrading } from './PaperTradingContext';

export default function WatchlistPanel({ onViewCoin }) {
  const { positions, closePosition } = usePaperTrading();
  const waiting = positions.filter((p) => p.tokensHeld === 0);

  if (waiting.length === 0) return null;

  return (
    <div style={{ maxWidth: '100%', margin: '20px 0', padding: 16, border: '1px solid #2e303a', borderRadius: 8, background: '#17181f', boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px' }}>
      <h3>Analyzing / Waiting for Entry ({waiting.length})</h3>
      <div style={{ maxHeight: 420, overflowY: 'auto', overflowX: 'auto' }}>
<table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #2e303a', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>Coin</th>
            <th style={{ padding: 8 }}>Budget</th>
            <th style={{ padding: 8 }}>Pullback from High</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {waiting.map((p) => {
            const drawdownPct = ((p.referenceHigh - p.currentPrice) / p.referenceHigh) * 100;
            return (
              <tr
                key={p.id}
                style={{ borderBottom: '1px solid #222', cursor: 'pointer' }}
                onClick={() => onViewCoin(p)}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#1f2028')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: 8 }}>{p.symbol}</td>
                <td style={{ padding: 8 }}>${p.budgetUsd.toFixed(2)}</td>
                <td style={{ padding: 8, color: drawdownPct > 0 ? '#f44336' : '#888' }}>
                  {drawdownPct.toFixed(2)}% (also watching for a spike)
                </td>
                <td style={{ padding: 8 }}>
                  <button onClick={(e) => { e.stopPropagation(); onViewCoin(p); }} style={{ marginRight: 6 }}>View</button>
                  <button onClick={(e) => { e.stopPropagation(); closePosition(p.id); }}>Cancel</button>
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
