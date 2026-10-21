import { useEffect, useMemo, useState } from 'react';
import { usePaperTrading } from './PaperTradingContext';
import { getGemScanFeed, scanStats } from './earlyGemScanner';

function fmtMC(v) {
  if (!v || v <= 0) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

const COLORS = { buy: '#4caf50', sell: '#f44336', gem: '#4caf50' };
const LABEL = { buy: 'BUY', sell: 'SELL', gem: 'GEM' };

// Live activity log, like the log in SolBot: every buy/sell the bot made plus what the early-gem
// scanner found (good coins only, in green). Newest first.
export default function BotLog() {
  const { positions, closedTrades } = usePaperTrading();
  const [filter, setFilter] = useState('all'); // all | trades | scanner
  const [tick, setTick] = useState(0);

  // the scanner feed lives outside React state, so re-read it every couple of seconds
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2500);
    return () => clearInterval(id);
  }, []);

  const lines = useMemo(() => {
    const out = [];
    const addFills = (symbol, fills, tag) => {
      for (const f of fills || []) {
        out.push({
          key: `${tag}-${f.id}`,
          t: f.t,
          kind: f.type === 'buy' ? 'buy' : 'sell',
          group: 'trades',
          sym: symbol,
          text: `$${(f.usdAmount || 0).toFixed(2)}${f.marketCap ? ` @ ${fmtMC(f.marketCap)} MC` : ''} - ${f.reason || ''}`,
        });
      }
    };
    positions.forEach((p) => addFills(p.symbol, p.fills, p.id));
    closedTrades.forEach((c, i) => addFills(c.symbol, c.fills, `c${i}-${c.id}`));
    // only good finds - coins the scanner skipped are never shown
    for (const f of getGemScanFeed()) {
      if (f.status !== 'gem') continue;
      out.push({ key: `s-${f.mint}-${f.at}`, t: f.at, kind: 'gem', group: 'scanner', sym: f.sym, text: `Early gem detected${f.mc ? ' @ ' + fmtMC(f.mc) + ' MC' : ''} - ${f.why}` });
    }
    return out
      .filter((l) => filter === 'all' || l.group === filter)
      .sort((a, b) => b.t - a.t)
      .slice(0, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, closedTrades, filter, tick]);

  const chip = (id, label) => (
    <button
      key={id}
      onClick={() => setFilter(id)}
      style={{ padding: '3px 10px', fontSize: 12, borderRadius: 99, fontWeight: filter === id ? 'bold' : 'normal', background: filter === id ? '#2a2c38' : undefined }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ padding: 16, border: '1px solid #2e303a', borderRadius: 8, background: '#17181f', margin: '20px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Bot log</h3>
        <div style={{ display: 'flex', gap: 6 }}>{chip('all', 'All')}{chip('trades', 'Trades')}{chip('scanner', 'Gems found')}</div>
      </div>
      {/* one quiet health line so you can tell the scanner is alive - no per-coin skip lines */}
      <div style={{ fontSize: 11, color: scanStats.error ? '#f44336' : '#777', marginBottom: 6 }}>
        {scanStats.at
          ? `Scanner last ran ${new Date(scanStats.at).toLocaleTimeString()} · ${scanStats.evaluated} coins checked · ${scanStats.passedFilters} passed filters · ${scanStats.blocked} blocked by safety${Object.keys(scanStats.blockedWhy).length ? ' (' + Object.entries(scanStats.blockedWhy).map(([k, v]) => `${v}× ${k}`).join(', ') + ')' : ''}${scanStats.error ? ' · error: ' + scanStats.error : ''}`
          : 'Scanner starting...'}
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, background: '#0d0e13', border: '1px solid #222', borderRadius: 6 }}>
        {lines.length === 0 && <div style={{ padding: 12, color: '#777' }}>Nothing yet. Gems the scanner finds and the trades the bot makes show up here.</div>}
        {lines.map((l) => (
          <div key={l.key} style={{ display: 'flex', gap: 10, padding: '4px 10px', borderBottom: '1px solid #181a22' }}>
            <span style={{ color: '#666', flexShrink: 0 }}>{new Date(l.t).toLocaleTimeString()}</span>
            <span style={{ color: COLORS[l.kind], fontWeight: 'bold', width: 38, flexShrink: 0 }}>{LABEL[l.kind]}</span>
            <span style={{ color: l.kind === 'gem' ? '#4caf50' : '#eee', fontWeight: 'bold', flexShrink: 0 }}>{l.sym}</span>
            <span style={{ color: l.kind === 'gem' ? '#4caf50' : '#9aa0b0', overflowWrap: 'anywhere' }}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
