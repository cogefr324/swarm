// Client side of the discovery feed. The lists are built once on the server (server/feed.js) and
// cached there, so every refresh is one cheap request and all users see the same consistent data.
import { api } from './api';
import { buildFeed } from './feedCore';
export { ALL_LAUNCHPADS } from './feedCore';

export async function fetchTrendingFeed() {
  let data;
  try {
    data = await api.feed();
  } catch (e) {
    // Server not updated/restarted (or unreachable): build the feed in the browser instead so the
    // lists still work. Restart the server to get the faster, consistent shared version.
    console.warn(`[trendingFeed] /api/feed unavailable (${e.message}) - building the feed in the browser. Restart the server to fix.`);
    data = await buildFeed({ fetchJson });
  }
  return {
    newPairs: data.newPairs || [],
    finalStretch: data.finalStretch || [],
    migrated: data.migrated || [],
    trending: data.trending || [],
    trendingWindows: data.trendingWindows || null,
    top: data.top || [],
    launchpads: data.launchpads || [],
    serverVersion: data.serverVersion || null,
  };
}

const respCache = new Map(); // url -> { at, data }
const inFlightReq = new Map(); // url -> promise

function ttlFor(url) {
  if (url.includes('jup.ag')) return 15 * 1000;
  return 30 * 1000;
}

async function fetchJson(url) {
  const cached = respCache.get(url);
  if (cached && Date.now() - cached.at < ttlFor(url)) return cached.data;
  if (inFlightReq.has(url)) return inFlightReq.get(url);
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[trendingFeed] ${url} -> HTTP ${res.status}${cached ? ' (using last good data)' : ''}`);
        return cached ? cached.data : null;
      }
      const data = await res.json();
      respCache.set(url, { at: Date.now(), data });
      return data;
    } catch (e) {
      console.warn(`[trendingFeed] ${url} -> network error: ${e.message}`);
      return cached ? cached.data : null;
    } finally {
      inFlightReq.delete(url);
    }
  })();
  inFlightReq.set(url, p);
  return p;
}


// Look up the best DexScreener pair for a clicked coin so the detail panel/trading has a
// pairAddress. Falls back to the Jupiter data if DexScreener doesn't answer.
export async function resolveEntry(entry) {
  if (entry.pairAddress) return entry;
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${entry.mint}`);
  const pairs = (json?.pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === entry.mint);
  if (!pairs.length) return entry;
  const best = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
  const mc = best.marketCap || best.fdv || entry.marketCap;
  return {
    ...entry,
    pairAddress: best.pairAddress,
    priceUsd: parseFloat(best.priceUsd) || entry.priceUsd,
    liquidityUsd: best.liquidity?.usd || entry.liquidityUsd,
    volume24h: best.volume?.h24 || entry.volume24h,
    marketCap: mc,
    marketCapIsFdv: !best.marketCap,
    dexUrl: best.url || null,
    // real 24h/6h/1h/5m trade counts and price changes from DexScreener (the list entries only had estimates)
    priceChange24h: best.priceChange?.h24 != null ? Number(best.priceChange.h24) : entry.priceChange24h,
    priceChange: {
      m5: Number(best.priceChange?.m5) || 0,
      h1: Number(best.priceChange?.h1) || 0,
      h6: Number(best.priceChange?.h6) || 0,
      h24: Number(best.priceChange?.h24) || 0,
    },
    txns: {
      m5: best.txns?.m5 || { buys: 0, sells: 0 },
      h1: best.txns?.h1 || { buys: 0, sells: 0 },
      h6: best.txns?.h6 || { buys: 0, sells: 0 },
      h24: best.txns?.h24 || { buys: 0, sells: 0 },
    },
    pairCreatedAt: best.pairCreatedAt || entry.pairCreatedAt,
    dexId: best.dexId || null,
  };
}
