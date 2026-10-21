import { ComposedChart, Line, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

function formatMC(val) {
  if (!val || val <= 0) return 'N/A';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
  return `$${val.toFixed(0)}`;
}

// Custom marker: a filled circle with a bold "B" or "S" letter inside it, drawn directly on
// the chart at the exact time/market-cap the bot bought or sold.
function FillMarker(props) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const isBuy = payload.type === 'buy';
  return (
    <g>
      <circle cx={cx} cy={cy} r={9} fill={isBuy ? '#4caf50' : '#f44336'} stroke="#0e0f13" strokeWidth={1.5} />
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight="bold" fill="#fff">
        {isBuy ? 'B' : 'S'}
      </text>
    </g>
  );
}

export default function PositionChart({ position, settings }) {
  const history = position.priceHistory || [];
  if (history.length === 0) return null;

  const chartData = history.map((h) => ({ t: h.t, marketCap: h.marketCap }));
  const fillData = (position.fills || []).map((f) => ({ t: f.t, marketCap: f.marketCap, type: f.type, reason: f.reason }));

  const mcPerPrice = position.currentPrice > 0 ? position.currentMarketCap / position.currentPrice : 0;
  const avgCostMc = position.avgCostBasis > 0 ? position.avgCostBasis * mcPerPrice : null;
  const stopLossMc = avgCostMc ? avgCostMc * (1 - settings.stopLossPct / 100) : null;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ marginBottom: 8 }}>Market Cap Since Entry ({position.fills.length} fill{position.fills.length !== 1 ? 's' : ''})</h4>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => new Date(t).toLocaleTimeString()}
            tick={{ fontSize: 10 }}
            allowDuplicatedCategory={false}
          />
          <YAxis dataKey="marketCap" type="number" domain={['auto', 'auto']} tickFormatter={(v) => formatMC(v)} tick={{ fontSize: 10 }} width={70} />
          <Tooltip
            labelFormatter={(t) => new Date(t).toLocaleTimeString()}
            formatter={(v, name, props) => {
              if (props.payload.reason) return [`${formatMC(v)} — ${props.payload.type.toUpperCase()}: ${props.payload.reason}`, ''];
              return [formatMC(v), 'Market Cap'];
            }}
          />

          {avgCostMc && (
            <ReferenceLine y={avgCostMc} stroke="#c084fc" strokeDasharray="4 4" label={{ value: `Avg Cost ${formatMC(avgCostMc)}`, fontSize: 11, fill: '#c084fc', position: 'insideTopLeft' }} />
          )}
          {stopLossMc && (
            <ReferenceLine y={stopLossMc} stroke="#f44336" strokeDasharray="4 4" label={{ value: `Stop Loss ${formatMC(stopLossMc)}`, fontSize: 11, fill: '#f44336', position: 'insideBottomLeft' }} />
          )}

          <Line data={chartData} dataKey="marketCap" type="monotone" stroke="#8884d8" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Scatter data={fillData} dataKey="marketCap" shape={FillMarker} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
        🟢 B = tranche buy &nbsp; 🔴 S = tranche sell &nbsp; Purple dashed = average cost basis &nbsp;
        Red dashed = hard stop-loss. Hover any point for details. This tracks only since the bot
        started farming this coin.
      </div>
    </div>
  );
}
