import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from './api';
import CoinIcon from './CoinIcon';
import { fetchTrendingFeed, resolveEntry, ALL_LAUNCHPADS } from './trendingFeed';
import { cleanTop, isDumpingOrFake } from './feedCore';
import { SERVER_VERSION } from './version';

const POLL_INTERVAL_MS = 8000;
const TABS = [
  { id: 'top', label: '👑 Top' },
  { id: 'trending', label: '🔥 Trending' },
  { id: 'newPairs', label: '🆕 New Pairs' },
];

function formatMC(val) {
  if (!val || val <= 0) return 'N/A';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatAge(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function Card({ entry, onSelect, opening }) {
  const wn = entry.win;
  const ch = wn ? wn.priceChange : entry.priceChange24h;
  return (
    <div
      onClick={() => onSelect(entry)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#111a26', border: '1px solid #223247', borderRadius: 8, cursor: 'pointer', opacity: opening ? 0.5 : 1 }}
    >
      <CoinIcon mint={entry.mint} src={entry.iconUrl} symbol={entry.symbol} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>
          {entry.symbol} <span style={{ color: '#8296ad', fontWeight: 'normal', fontSize: 11 }}>{formatAge(entry.pairCreatedAt)}</span>
        </div>
        <div style={{ fontSize: 11, color: '#5ec8ff' }}>
          {entry.launchpad}
          {(entry.txns?.m5?.buys || entry.txns?.m5?.sells) ? (
            <span style={{ color: '#8296ad' }}> · 5m <span style={{ color: '#3ddc97' }}>{entry.txns.m5.buys}B</span>/<span style={{ color: '#ff5d6c' }}>{entry.txns.m5.sells}S</span></span>
          ) : null}
        </div>
        {wn && (
          <div style={{ fontSize: 11, color: '#8296ad' }}>
            {({ m5: '5m', h1: '1h', h6: '6h', h24: '24h' })[wn.window]} vol {formatMC(wn.volumeUsd)} · {wn.swaps} swaps{wn.wallets ? ` · ${wn.wallets} wallets` : ''}
          </div>
        )}
        {entry.bondingProgress != null && entry.bondingProgress < 1 && (
          <div title={`Bonding curve ${(entry.bondingProgress * 100).toFixed(0)}%`} style={{ marginTop: 4, height: 3, background: '#223247', borderRadius: 2, width: '80%' }}>
            <div style={{ width: `${Math.round(entry.bondingProgress * 100)}%`, height: '100%', background: entry.bondingProgress >= 0.5 ? '#3ddc97' : '#5ec8ff', borderRadius: 2 }} />
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', fontSize: 12 }}>
        <div>MC {formatMC(entry.marketCap)}</div>
        <div style={{ color: '#8296ad', fontSize: 11 }}>{entry.holders ? `${entry.holders.toLocaleString()} holders · ` : ''}{entry.liquidityUsd > 0 ? `L ${formatMC(entry.liquidityUsd)} · ` : ''}V {formatMC(entry.volume24h)}</div>
        <div style={{ color: ch >= 0 ? '#3ddc97' : '#ff5d6c' }}>{ch >= 0 ? '+' : ''}{(ch || 0).toFixed(1)}%</div>
      </div>
    </div>
  );
}


// Compact one-line-per-coin table for the Top tab.
function TopTable({ entries, onSelect, opening }) {
  const td = { padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' };
  const th = { ...td, color: '#8296ad', fontWeight: 'normal', position: 'sticky', top: 0, background: '#111a26' };
  return (
    <div style={{ overflow: 'auto', maxHeight: '72vh', border: '1px solid #223247', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr><th style={{ ...th, textAlign: 'left' }}>#</th><th style={{ ...th, textAlign: 'left' }}>Token</th><th style={th}>MC</th><th style={th}>Liq</th><th style={th}>Holders</th><th style={th}>Vol 24h</th><th style={th}>24h %</th></tr></thead>
        <tbody>
          {entries.map((e, i) => {
            const ch = e.priceChange24h;
            return (
              <tr key={e.mint} onClick={() => onSelect(e)} style={{ cursor: 'pointer', borderTop: '1px solid #223247', opacity: opening === e.mint ? 0.5 : 1 }}>
                <td style={{ ...td, textAlign: 'left', color: '#8296ad' }}>{i + 1}</td>
                <td style={{ ...td, textAlign: 'left' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <CoinIcon mint={e.mint} src={e.iconUrl} symbol={e.symbol} size={20} />
                    <b>{e.symbol}</b> <span style={{ color: '#8296ad', fontSize: 11 }}>{formatAge(e.pairCreatedAt)}</span>
                  </span>
                </td>
                <td style={td}>{formatMC(e.marketCap)}</td>
                <td style={td}>{e.liquidityUsd > 0 ? formatMC(e.liquidityUsd) : '-'}</td>
                <td style={{ ...td, color: '#aaa' }}>{e.holders ? e.holders.toLocaleString() : '-'}</td>
                <td style={td}>{formatMC(e.volume24h)}</td>
                <td style={td}>{pctCell(ch)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Axiom-style table for the Trending tab: rank, token, age, market cap, liquidity, volume, txns, traders, price change per window.
const pctCell = (v) => (v == null ? <span style={{ color: '#666' }}>-</span> : <span style={{ color: v >= 0 ? '#3ddc97' : '#ff5d6c' }}>{v >= 0 ? '+' : ''}{Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%</span>);
function TrendingTable({ entries, win, onSelect, opening }) {
  const [sort, setSort] = useState({ key: 'rank', dir: 1 });
  const val = {
    rank: (r) => r.i, age: (r) => r.e.pairCreatedAt || 0, mc: (r) => r.e.marketCap || 0, liq: (r) => r.e.liquidityUsd || 0,
    vol: (r) => r.e.win?.volumeUsd ?? r.e.volume24h ?? 0, txns: (r) => r.e.win?.swaps ?? 0,
    chg: (r) => r.e.win?.priceChange ?? 0,
  };
  const rows = entries.map((e, i) => ({ e, i })).sort((a, b) => (val[sort.key](a) - val[sort.key](b)) * sort.dir);
  const th = (key, label, align = 'right') => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : (key === 'rank' ? 1 : -1) }))} style={{ cursor: 'pointer', textAlign: align, padding: '6px 8px', color: sort.key === key ? '#5ec8ff' : '#8296ad', fontWeight: 'normal', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#111a26' }}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const wl = ({ m5: '5m', h1: '1h', h6: '6h', h24: '24h' })[win];
  return (
    <div style={{ overflow: 'auto', maxHeight: '72vh', border: '1px solid #223247', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr>{th('rank', '#', 'left')}{th('rank', 'Token', 'left')}{th('age', 'Age')}{th('mc', 'MC')}{th('liq', 'Liq')}<th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>Holders</th>{th('vol', `Vol ${wl}`)}{th('txns', 'Txns')}<th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>Traders</th>{th('chg', `${wl} %`)}<th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>5m</th><th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>1h</th><th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>6h</th><th style={{ padding: '6px 8px', color: '#8296ad', fontWeight: 'normal', textAlign: 'right', position: 'sticky', top: 0, background: '#111a26' }}>24h</th></tr></thead>
        <tbody>
          {rows.map(({ e, i }) => {
            const a = e.allWin || {}; const w = e.win || {};
            return (
              <tr key={e.mint} onClick={() => onSelect(e)} style={{ cursor: 'pointer', borderTop: '1px solid #223247', opacity: opening === e.mint ? 0.5 : 1 }}>
                <td style={{ padding: '6px 8px', color: '#8296ad' }}>{i + 1}</td>
                <td style={{ padding: '6px 8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 150 }}>
                    <CoinIcon mint={e.mint} src={e.iconUrl} symbol={e.symbol} size={28} />
                    <div><div style={{ fontWeight: 'bold' }}>{e.symbol}</div><div style={{ color: '#5ec8ff', fontSize: 10 }}>{e.launchpad}</div></div>
                  </div>
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#aaa' }}>{formatAge(e.pairCreatedAt)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatMC(e.marketCap)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatMC(e.liquidityUsd)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#aaa' }}>{e.holders ? e.holders.toLocaleString() : '-'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatMC(w.volumeUsd)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{w.swaps ?? 0}<div style={{ fontSize: 10 }}><span style={{ color: '#3ddc97' }}>{w.buys ?? 0}</span>/<span style={{ color: '#ff5d6c' }}>{w.sells ?? 0}</span></div></td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#aaa' }}>{w.wallets || '-'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{pctCell(w.priceChange)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{pctCell(a.m5?.priceChange)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{pctCell(a.h1?.priceChange)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{pctCell(a.h6?.priceChange)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{pctCell(a.h24?.priceChange)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TrendingPanel({ onSelectCoin }) {
  const [feed, setFeed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trendingFeedCache') || 'null'); } catch { return null; }
  });
  const [win, setWin] = useState('h1');
  const [tab, setTab] = useState('top');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hidden, setHidden] = useState(() => new Set());
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const [opening, setOpening] = useState(null);

  async function handleSelect(entry) {
    setOpening(entry.mint);
    try { onSelectCoin(await resolveEntry(entry)); } finally { setOpening(null); }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (inFlight.current) return; // StrictMode / overlapping polls
      inFlight.current = true;
      try {
        const data = await fetchTrendingFeed();
        if (!cancelled) {
          setFeed(data);
          setError(false);
          try { localStorage.setItem('trendingFeedCache', JSON.stringify(data)); } catch { /* ignore */ }
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        inFlight.current = false;
      }
    }
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // New Pairs also includes the Final Stretch coins (nearly-graduated launches), newest first;
  // the progress bar on each card shows how close it is to graduating.
  const activeEntries = useMemo(() => {
    if (!feed) return [];
    // fake-market + one-token-per-ticker cleanup also runs here, so it works even if the server is out of date
    if (tab === 'top') return cleanTop((feed.top || []).filter((e) => e.marketCap >= 10e6));
    if (tab === 'trending') return ((feed.trendingWindows && feed.trendingWindows[win]) || feed.trending || []).filter((e) => !isDumpingOrFake(e));
    if (tab !== 'newPairs') return feed[tab] || [];
    const seen = new Set();
    return [...(feed.newPairs || []), ...(feed.finalStretch || [])]
      .filter((e) => !seen.has(e.mint) && seen.add(e.mint))
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
  }, [feed, tab, win]);
  // Sidebar always lists every Solana launchpad; any other venue present in the data is appended
  const visibleLaunchpads = useMemo(() => {
    const extras = [...new Set(activeEntries.map((e) => e.launchpad))].filter((l) => !ALL_LAUNCHPADS.includes(l)).sort();
    return [...ALL_LAUNCHPADS, ...extras];
  }, [activeEntries]);
  const shown = activeEntries.filter((e) => !hidden.has(e.launchpad));

  function toggle(lp) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(lp) ? next.delete(lp) : next.add(lp);
      return next;
    });
  }

  const staleServer = feed && !feed.serverVersion; // only an old server (no version field at all) triggers this
  return (
    <div style={{ margin: '20px 0', textAlign: 'left' }}>
      {staleServer && (
        <div style={{ background: '#3a1f1f', border: '1px solid #ff5d6c', color: '#ffb4ab', padding: '10px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>
          <b>Your server is running OLD code{feed.serverVersion ? ` (${feed.serverVersion})` : ''}</b> - the new safety filters (mintable / LP unlocked / fake caps) are not active on it.
          Stop the server (Ctrl+C in the terminal where you ran <code>npm start</code>) and start it again in the <code>server</code> folder. It should print <code>[build {SERVER_VERSION}]</code>.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', fontWeight: tab === t.id ? 'bold' : 'normal', background: tab === t.id ? '#5ec8ff' : undefined, color: tab === t.id ? '#1a1a1a' : undefined }}
          >
            {t.label}
          </button>
        ))}
        {tab === 'trending' && feed?.trendingWindows && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            {[['m5', '5m'], ['h1', '1h'], ['h6', '6h'], ['h24', '24h']].map(([id, label]) => (
              <button key={id} onClick={() => setWin(id)} style={{ padding: '4px 10px', fontWeight: win === id ? 'bold' : 'normal', background: win === id ? '#3ddc97' : undefined, color: win === id ? '#fff' : undefined }}>{label}</button>
            ))}
          </span>
        )}
        <button onClick={() => setSidebarOpen((o) => !o)} style={{ marginLeft: 'auto', padding: '6px 14px' }}>
          {sidebarOpen ? 'Hide' : 'Show'} Launchpads
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {sidebarOpen && (
          <div style={{ width: 190, flexShrink: 0, maxHeight: 520, overflowY: 'auto', background: '#111a26', border: '1px solid #223247', borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 12, color: '#8296ad', marginBottom: 6 }}>Launchpads</div>
            {visibleLaunchpads.map((lp) => {
              const count = activeEntries.filter((e) => e.launchpad === lp).length;
              const off = hidden.has(lp);
              return (
                <div key={lp} onClick={() => toggle(lp)} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 6px', fontSize: 12, cursor: 'pointer', opacity: off ? 0.4 : count === 0 ? 0.55 : 1 }}>
                  <span>{off ? '🚫' : '✅'} {lp}</span>
                  <span style={{ color: '#8296ad' }}>{count}</span>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'trending' ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            {!feed && !error && <div style={{ color: '#8296ad' }}>Loading...</div>}
            {error && !feed && <div style={{ color: '#ff5d6c' }}>Couldn't load the feed. Retrying...</div>}
            {feed && shown.length === 0 && <div style={{ color: '#8296ad' }}>No coins are trending in this window right now.</div>}
            {shown.length > 0 && <TrendingTable entries={shown} win={win} onSelect={handleSelect} opening={opening} />}
          </div>
        ) : tab === 'top' ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            {!feed && !error && <div style={{ color: '#8296ad' }}>Loading...</div>}
            {error && !feed && <div style={{ color: '#ff5d6c' }}>Couldn't load the feed. Retrying...</div>}
            {feed && shown.length === 0 && <div style={{ color: '#8296ad' }}>No coins to show.</div>}
            {shown.length > 0 && <TopTable entries={shown} onSelect={handleSelect} opening={opening} />}
          </div>
        ) : (
        <div style={{ flex: 1, minWidth: 0, maxHeight: '72vh', overflowY: 'auto', paddingRight: 4, display: 'grid', alignContent: 'start', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {!feed && !error && <div style={{ color: '#8296ad' }}>Loading...</div>}
          {error && !feed && <div style={{ color: '#ff5d6c' }}>Couldn't load the feed. Retrying...</div>}
          {feed && shown.length === 0 && <div style={{ color: '#8296ad' }}>No coins to show.</div>}
          {shown.map((e) => (
            <Card key={e.mint} entry={e} onSelect={handleSelect} opening={opening === e.mint} />
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
