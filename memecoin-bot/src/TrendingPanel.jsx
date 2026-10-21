import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from './api';
import CoinIcon from './CoinIcon';
import { fetchTrendingFeed, resolveEntry, ALL_LAUNCHPADS } from './trendingFeed';
import { cleanTop, isDumpingOrFake } from './feedCore';
import { SERVER_VERSION } from './version';

const POLL_INTERVAL_MS = 10000;
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
  const ch = entry.priceChange24h;
  return (
    <div
      onClick={() => onSelect(entry)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#17181f', border: '1px solid #2e303a', borderRadius: 8, cursor: 'pointer', opacity: opening ? 0.5 : 1 }}
    >
      <CoinIcon mint={entry.mint} src={entry.iconUrl} symbol={entry.symbol} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>
          {entry.symbol} <span style={{ color: '#888', fontWeight: 'normal', fontSize: 11 }}>{formatAge(entry.pairCreatedAt)}</span>
        </div>
        <div style={{ fontSize: 11, color: '#c084fc' }}>
          {entry.launchpad}
          {(entry.txns?.m5?.buys || entry.txns?.m5?.sells) ? (
            <span style={{ color: '#888' }}> · 5m <span style={{ color: '#4caf50' }}>{entry.txns.m5.buys}B</span>/<span style={{ color: '#f44336' }}>{entry.txns.m5.sells}S</span></span>
          ) : null}
        </div>
        {entry.bondingProgress != null && entry.bondingProgress < 1 && (
          <div title={`Bonding curve ${(entry.bondingProgress * 100).toFixed(0)}%`} style={{ marginTop: 4, height: 3, background: '#2e303a', borderRadius: 2, width: '80%' }}>
            <div style={{ width: `${Math.round(entry.bondingProgress * 100)}%`, height: '100%', background: entry.bondingProgress >= 0.5 ? '#4caf50' : '#c084fc', borderRadius: 2 }} />
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', fontSize: 12 }}>
        <div>MC {formatMC(entry.marketCap)}</div>
        <div style={{ color: '#888', fontSize: 11 }}>{entry.liquidityUsd > 0 ? `L ${formatMC(entry.liquidityUsd)} · ` : ''}V {formatMC(entry.volume24h)}</div>
        <div style={{ color: ch >= 0 ? '#4caf50' : '#f44336' }}>{ch >= 0 ? '+' : ''}{(ch || 0).toFixed(1)}%</div>
      </div>
    </div>
  );
}

export default function TrendingPanel({ onSelectCoin }) {
  const [feed, setFeed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trendingFeedCache') || 'null'); } catch { return null; }
  });
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
    if (tab === 'trending') return (feed.trending || []).filter((e) => !isDumpingOrFake(e));
    if (tab !== 'newPairs') return feed[tab] || [];
    const seen = new Set();
    return [...(feed.newPairs || []), ...(feed.finalStretch || [])]
      .filter((e) => !seen.has(e.mint) && seen.add(e.mint))
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
  }, [feed, tab]);
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
        <div style={{ background: '#3a1f1f', border: '1px solid #f44336', color: '#ffb4ab', padding: '10px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>
          <b>Your server is running OLD code{feed.serverVersion ? ` (${feed.serverVersion})` : ''}</b> - the new safety filters (mintable / LP unlocked / fake caps) are not active on it.
          Stop the server (Ctrl+C in the terminal where you ran <code>npm start</code>) and start it again in the <code>server</code> folder. It should print <code>[build {SERVER_VERSION}]</code>.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', fontWeight: tab === t.id ? 'bold' : 'normal', background: tab === t.id ? '#c084fc' : undefined, color: tab === t.id ? '#1a1a1a' : undefined }}
          >
            {t.label}
          </button>
        ))}
        <button onClick={() => setSidebarOpen((o) => !o)} style={{ marginLeft: 'auto', padding: '6px 14px' }}>
          {sidebarOpen ? 'Hide' : 'Show'} Launchpads
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {sidebarOpen && (
          <div style={{ width: 190, flexShrink: 0, maxHeight: 520, overflowY: 'auto', background: '#17181f', border: '1px solid #2e303a', borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Launchpads</div>
            {visibleLaunchpads.map((lp) => {
              const count = activeEntries.filter((e) => e.launchpad === lp).length;
              const off = hidden.has(lp);
              return (
                <div key={lp} onClick={() => toggle(lp)} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 6px', fontSize: 12, cursor: 'pointer', opacity: off ? 0.4 : count === 0 ? 0.55 : 1 }}>
                  <span>{off ? '🚫' : '✅'} {lp}</span>
                  <span style={{ color: '#888' }}>{count}</span>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, maxHeight: '72vh', overflowY: 'auto', paddingRight: 4, display: 'grid', alignContent: 'start', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {!feed && !error && <div style={{ color: '#888' }}>Loading...</div>}
          {error && !feed && <div style={{ color: '#f44336' }}>Couldn't load the feed. Retrying...</div>}
          {feed && shown.length === 0 && <div style={{ color: '#888' }}>No coins to show.</div>}
          {shown.map((e) => (
            <Card key={e.mint} entry={e} onSelect={handleSelect} opening={opening === e.mint} />
          ))}
        </div>
      </div>
    </div>
  );
}
