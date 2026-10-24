import { useState } from 'react';

const MIN_LIQUIDITY_USD = 2000;

function formatMC(val, isFdv) {
  if (!val || val <= 0) return 'N/A';
  const suffix = isFdv ? ' (FDV)' : '';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B${suffix}`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M${suffix}`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K${suffix}`;
  return `$${val.toFixed(0)}${suffix}`;
}

export default function CoinSearch({ onSelectCoin }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function search() {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setResults([]);
    setShowAll(false);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      let pairs = (data.pairs || []).filter((p) => p.chainId === 'solana');

      if (pairs.length === 0) {
        setError('No Solana pairs found for that search.');
        setLoading(false);
        return;
      }

      const qLower = q.toLowerCase();
      const isLikelyAddress = q.length >= 32;

      let filtered = pairs;
      if (isLikelyAddress) {
        const exactAddress = pairs.filter((p) => p.baseToken.address.toLowerCase() === qLower);
        if (exactAddress.length > 0) filtered = exactAddress;
      } else {
        const exactTicker = pairs.filter((p) => p.baseToken.symbol.toLowerCase() === qLower);
        if (exactTicker.length > 0) filtered = exactTicker;
      }

      const withLiquidity = filtered.filter((p) => (p.liquidity?.usd || 0) >= MIN_LIQUIDITY_USD);
      if (withLiquidity.length > 0) filtered = withLiquidity;

      const bestPairByMint = new Map();
      for (const pair of filtered) {
        const mint = pair.baseToken.address;
        const existing = bestPairByMint.get(mint);
        if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
          bestPairByMint.set(mint, pair);
        }
      }

      const sorted = [...bestPairByMint.values()]
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .slice(0, 6);

      setResults(sorted);
    } catch (e) {
      setError(`Search failed: ${e.message}`);
    }
    setLoading(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') search();
  }

  function pickCoin(pair) {
    const hasRealMarketCap = !!pair.marketCap;
    onSelectCoin({
      mint: pair.baseToken.address,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      priceUsd: parseFloat(pair.priceUsd),
      liquidityUsd: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      priceChange: {
        m5: pair.priceChange?.m5 || 0,
        h1: pair.priceChange?.h1 || 0,
        h6: pair.priceChange?.h6 || 0,
        h24: pair.priceChange?.h24 || 0,
      },
      txns: {
        m5: pair.txns?.m5 || { buys: 0, sells: 0 },
        h1: pair.txns?.h1 || { buys: 0, sells: 0 },
        h6: pair.txns?.h6 || { buys: 0, sells: 0 },
        h24: pair.txns?.h24 || { buys: 0, sells: 0 },
      },
      pairCreatedAt: pair.pairCreatedAt || null,
      marketCap: pair.marketCap || pair.fdv || 0,
      marketCapIsFdv: !hasRealMarketCap, // true = this is FDV (ignores burns), not real circulating MC
      iconUrl: pair.info?.imageUrl || null,
      dexUrl: pair.url,
    });
    setResults([]);
    setQuery('');
    setShowAll(false);
  }

  function renderRow(pair, isLast) {
    const mc = pair.marketCap || pair.fdv || 0;
    const isFdv = !pair.marketCap;
    return (
      <div
        key={pair.pairAddress}
        onClick={() => pickCoin(pair)}
        style={{
          padding: '10px 14px',
          cursor: 'pointer',
          borderBottom: isLast ? 'none' : '1px solid #223247',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#162233')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {pair.info?.imageUrl ? (
            <img
              src={pair.info.imageUrl}
              alt={pair.baseToken.symbol}
              style={{ width: 32, height: 32, borderRadius: '50%' }}
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          ) : (
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#223247', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>
              ?
            </div>
          )}
          <div>
            <div><strong>{pair.baseToken.symbol}</strong></div>
            <div style={{ color: '#8296ad', fontSize: 12 }}>{pair.baseToken.name}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          <div style={{ fontWeight: 'bold' }}>MC: {formatMC(mc, isFdv)}</div>
          <div style={{ color: pair.priceChange?.h24 >= 0 ? '#3ddc97' : '#ff5d6c', fontSize: 12 }}>
            {pair.priceChange?.h24?.toFixed(2)}% (24h)
          </div>
        </div>
      </div>
    );
  }

  const topMatch = results[0];
  const otherMatches = results.slice(1);

  return (
    <div style={{ maxWidth: '100%', margin: '0 auto', padding: '16px 0' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search by ticker or contract address..."
          style={{ flex: 1, padding: '10px 12px', fontSize: 14, borderRadius: 8, border: '1px solid #223247' }}
        />
        <button onClick={search} disabled={loading} style={{ padding: '10px 18px', borderRadius: 8 }}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && <div style={{ marginTop: 8, color: '#ff5d6c', fontSize: 13 }}>{error}</div>}

      {topMatch && (
        <div style={{ marginTop: 12, border: '1px solid #223247', borderRadius: 8, maxHeight: 380, overflowY: 'auto' }}>
          {renderRow(topMatch, otherMatches.length === 0)}

          {otherMatches.length > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              style={{ width: '100%', padding: '8px 14px', fontSize: 12, borderRadius: 0, border: 'none', borderTop: '1px solid #223247' }}
            >
              {otherMatches.length} other token{otherMatches.length > 1 ? 's' : ''} share this name
            </button>
          )}

          {showAll && otherMatches.map((pair, idx) => renderRow(pair, idx === otherMatches.length - 1))}
        </div>
      )}
    </div>
  );
}
