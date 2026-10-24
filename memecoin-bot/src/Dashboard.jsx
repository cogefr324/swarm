import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { usePaperTrading } from './PaperTradingContext';

export default function Dashboard({ onViewCoin }) {
  const { history, closedTrades } = usePaperTrading();

  const chartData = history.map((h) => ({
    time: new Date(h.t).toLocaleTimeString(),
    balance: h.balance,
    pnl: h.balance - 10000,
  }));

  return (
    <div style={{ maxWidth: 700, margin: '20px auto', padding: 16, border: '1px solid #223247', borderRadius: 8, background: '#111a26', boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px' }}>
      <h4>Balance & PnL Over Time</h4>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
          <Tooltip formatter={(v, name) => [`$${v.toFixed(2)}`, name]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="balance" stroke="#5ec8ff" dot={false} strokeWidth={2} name="Balance" />
          <Line type="monotone" dataKey="pnl" stroke="#3ddc97" dot={false} strokeWidth={2} name="PnL" />
        </LineChart>
      </ResponsiveContainer>

      {closedTrades.length > 0 && (
        <>
          <h4>Trade History</h4>
          <div style={{ maxHeight: 420, overflowY: 'auto', overflowX: 'auto' }}>
<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #333', textAlign: 'left' }}>
                <th style={{ padding: 6 }}>Coin</th>
                <th style={{ padding: 6 }}>Budget</th>
                <th style={{ padding: 6 }}>Avg Cost</th>
                <th style={{ padding: 6 }}>Exit Price</th>
                <th style={{ padding: 6 }}>Fills</th>
                <th style={{ padding: 6 }}>PnL</th>
                <th style={{ padding: 6 }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {[...closedTrades].reverse().map((t) => (
                <tr
                  key={t.id + t.closedAt}
                  style={{ borderBottom: '1px solid #222', cursor: onViewCoin ? 'pointer' : 'default' }}
                  onClick={() => onViewCoin && onViewCoin({ ...t, mint: t.mint || t.coinSnapshot?.mint || String(t.id).split('-')[0] })}
                >
                  <td style={{ padding: 6 }}>{t.symbol}</td>
                  <td style={{ padding: 6 }}>${t.budgetUsd?.toFixed(2) ?? 'N/A'}</td>
                  <td style={{ padding: 6 }}>{t.avgCostBasis ? `$${t.avgCostBasis.toFixed(8)}` : 'N/A'}</td>
                  <td style={{ padding: 6 }}>${t.exitPrice?.toFixed(8) ?? 'N/A'}</td>
                  <td style={{ padding: 6 }}>{t.fillCount ?? t.fills?.length ?? 0}</td>
                  <td style={{ padding: 6, color: t.pnlUsd >= 0 ? '#3ddc97' : '#ff5d6c' }}>
                    ${t.pnlUsd.toFixed(2)} ({t.pnlPct.toFixed(1)}%)
                  </td>
                  <td style={{ padding: 6 }}>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        </>
      )}
    </div>
  );
}
