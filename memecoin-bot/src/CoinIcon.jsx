import { useState, useEffect } from 'react';
import { api } from './api';

// Coin picture that never shows a blank hole. Tries, in order: the icon the data gave us (IPFS ones go
// through our server), DexScreener's image CDN, the Solana token-list logo, then a coloured circle
// with the coin's first letter. Most "missing" pictures were coins whose source had no icon at all.
export default function CoinIcon({ mint, src, symbol, size = 32 }) {
  const urls = [
    src ? api.imageUrl(src) : null,
    mint ? `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png` : null,
    mint ? `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mint}/logo.png` : null,
  ].filter(Boolean);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [mint, src]);

  if (i >= urls.length) {
    const hue = [...(mint || symbol || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    return (
      <div style={{ width: size, height: size, borderRadius: '50%', background: `hsl(${hue} 45% 32%)`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 'bold', flexShrink: 0 }}>
        {(symbol || '?').charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      key={urls[i]}
      src={urls[i]}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, objectFit: 'cover', background: '#2e303a' }}
      onError={() => setI((n) => n + 1)}
    />
  );
}
