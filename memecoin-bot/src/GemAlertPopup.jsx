import { useState, useEffect } from 'react';
import CoinIcon from './CoinIcon';

const LIFETIME_MS = 15000; // each popup removes itself after 15s, independently of the others

function formatMC(val) {
  if (!val || val <= 0) return 'N/A';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
  return `$${val.toFixed(0)}`;
}

function GemAlertCard({ alert, onDismiss, onBuy, autoBuyEnabled }) {
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  // Own 15s timer per card (starts when the card appears), so they vanish one by one.
  // Paused while the mouse is over it or "why?" is open, so you can finish reading.
  useEffect(() => {
    if (hover || expanded) return undefined;
    const t = setTimeout(() => onDismiss(alert.mint), LIFETIME_MS);
    return () => clearTimeout(t);
  }, [hover, expanded, alert.mint]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="gem-alert-popup"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 300,
        background: '#17181f',
        border: '1px solid #c084fc',
        borderRadius: 10,
        boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        marginBottom: 10,
      }}
    >
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{ padding: 12, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <CoinIcon mint={alert.mint} src={alert.iconUrl} symbol={alert.symbol} size={28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 'bold', color: '#c084fc', fontSize: 13 }}>🚀 Early Gem: {alert.symbol}</div>
            <div style={{ fontSize: 11, color: '#888' }}>MC {formatMC(alert.marketCap)} · {expanded ? 'hide' : 'why?'}</div>
          </div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onDismiss(alert.mint); }} style={{ padding: '2px 8px', fontSize: 12, flexShrink: 0 }}>
          ✕
        </button>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px', fontSize: 12 }}>
          <div style={{ color: '#aaa', marginBottom: 6 }}>Why the bot flagged this:</div>
          <ul style={{ margin: 0, paddingLeft: 16, color: '#ccc' }}>
            {alert.reasons.map((r, i) => (
              <li key={i} style={{ marginBottom: 2 }}>{r}</li>
            ))}
          </ul>
          <div style={{ marginTop: 8, color: '#888' }}>
            Price: ${alert.priceUsd < 0.01 ? alert.priceUsd.toFixed(8) : alert.priceUsd.toFixed(4)} · 24h: {alert.priceChange24h?.toFixed(1)}%
          </div>
          {autoBuyEnabled ? (
            <div style={{ marginTop: 10, fontSize: 12, color: '#4caf50' }}>Auto-buy enabled — handled automatically.</div>
          ) : (
            <button onClick={() => onBuy(alert)} style={{ marginTop: 10, width: '100%', background: '#c084fc', color: '#1a1a1a', border: 'none', fontWeight: 'bold' }}>
              Buy Now (Clip Mode)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function GemAlertPopup({ alerts, onDismiss, onBuy, autoBuyEnabled }) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 90,
        right: 16,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '80vh',
        overflowY: 'auto',
      }}
    >
      {alerts.map((alert) => (
        <GemAlertCard key={alert.mint} alert={alert} onDismiss={onDismiss} onBuy={onBuy} autoBuyEnabled={autoBuyEnabled} />
      ))}
    </div>
  );
}
