import { usePaperTrading } from './PaperTradingContext';
import { overallPnl, START_BALANCE } from './pnl';

const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const color = (v) => (v > 0 ? '#3ddc97' : v < 0 ? '#ff5d6c' : '#aaa');

function Tile({ label, value, sub, big, c }) {
  return (
    <div style={{ flex: '1 1 150px', padding: '10px 12px', background: '#162233', borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: '#8296ad' }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 18, fontWeight: 'bold', color: c || '#eee' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: c || '#8296ad' }}>{sub}</div>}
    </div>
  );
}

// Overall account PnL only. Open coins use live prices; closed rounds are included.
export default function PnlSummary({ onViewCoin }) {
  const { balance, positions, closedTrades, livePrices } = usePaperTrading();
  const o = overallPnl({ balance, positions, closedTrades, livePrices });

  return (
    <div style={{ padding: 16, border: '1px solid #223247', borderRadius: 8, background: '#111a26', margin: '20px 0' }}>
      <h3 style={{ marginTop: 0 }}>Profit &amp; loss</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <Tile big label="Overall PnL" value={money(o.total)} sub={`${pct(o.totalPct)} vs $${START_BALANCE.toLocaleString('en-US')} start`} c={color(o.total)} />
        <Tile label="Account value" value={`$${o.equity.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} sub={`$${o.cash.toFixed(2)} cash + $${o.openValue.toFixed(2)} in coins`} />
        <Tile label="Realized (locked in)" value={money(o.realized)} c={color(o.realized)} />
        <Tile label="Unrealized (open coins)" value={money(o.unrealized)} c={color(o.unrealized)} />
        <Tile label="Win rate" value={o.winRate == null ? '-' : `${o.winRate.toFixed(0)}%`} sub={`${o.wins} wins / ${o.losses} losses (closed)`} />
      </div>

    </div>
  );
}
