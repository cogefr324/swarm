// Pure feed builder (no browser APIs) - runs on the server so every client sees the same data.
// Discovery feed (Trending / New / Top) built on Jupiter's free Tokens API.
// One round trip of 4 parallel calls returns everything the cards need (price, market cap,
// liquidity, 24h change, age, launchpad), so the lists load fast and use very few requests.
// The DexScreener trading pair is only looked up lazily when you click a coin (resolveEntry).

const MIN_LIQUIDITY_USD = 1000;
const COLUMN_LIMIT = 100;
const TOP_LIMIT = 200;
const TOP_MIN_MCAP = 10e6; // Top only lists coins worth $10M or more // Top can run deeper - there are a lot of $10M+ Solana memecoins
const MAX_DROP_PCT = 80; // hide dead/rugged coins (down >80% in 24h) from Trending/New
const BASE_ASSETS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'USDS', 'PYUSD', 'JITOSOL', 'MSOL', 'BSOL']);
const JUP = 'https://lite-api.jup.ag/tokens/v2';

// Every Solana launchpad / venue we label and show in the sidebar (same set Axiom lists).
export const ALL_LAUNCHPADS = [
  'Pump', 'Mayhem', 'Bags', 'Bonk', 'Bonkers', 'Rise Rich', 'Stonkfun', 'Printr', 'Liquid',
  'Surge', 'Soar', 'Moonshot', 'Heaven', 'Daos.fun', 'Candle', 'Sugar', 'Believe',
  'Jupiter Studio', 'Moonit', 'Boop', 'LaunchLab', 'Dynamic BC', 'Raydium', 'Meteora AMM',
  'Meteora AMM V2', 'Orca', 'PancakeSwap', 'PumpSwap',
];

// Order matters: first match wins. Patterns run against the lowercased DEX id / name.
const NAME_RULES = [
  [/mayhem/, 'Mayhem'],
  [/bonkers/, 'Bonkers'],
  [/rise.?rich|risen?\b/, 'Rise Rich'],
  [/stonk/, 'Stonkfun'],
  [/printr/, 'Printr'],
  [/liquid/, 'Liquid'],
  [/surge/, 'Surge'],
  [/\bsoar\b/, 'Soar'],
  [/moonshot/, 'Moonshot'],
  [/moonit/, 'Moonit'],
  [/heaven/, 'Heaven'],
  [/daos/, 'Daos.fun'],
  [/candle/, 'Candle'],
  [/sugar/, 'Sugar'],
  [/believe/, 'Believe'],
  [/jup.*studio|jupstudio/, 'Jupiter Studio'],
  [/boop/, 'Boop'],
  [/bags/, 'Bags'],
  [/launchlab|letsbonk|bonkfun|bonk\.fun/, 'LaunchLab'],
  [/pump.?swap/, 'PumpSwap'], // PumpSwap is only the exchange a coin trades on, not proof it was launched on Pump
  [/pump/, 'Pump'],
  [/dbc|dynamic.?bond|dynamic.?bc/, 'Dynamic BC'],
  [/damm.?v?2|amm.?v2|meteora.*v2/, 'Meteora AMM V2'],
  [/meteora|damm|dlmm/, 'Meteora AMM'],
  [/raydium/, 'Raydium'],
  [/orca|whirlpool/, 'Orca'],
  [/pancake/, 'PancakeSwap'],
];

// Solana vanity mint suffixes some launchpads force on every token they create. This is the
// most reliable launchpad signal available, since DEX ids only name the AMM the coin trades on.
export function launchpadFromMint(mint) {
  if (!mint) return null;
  if (mint.endsWith('pump')) return 'Pump';
  if (mint.endsWith('bonk')) return 'Bonk';
  if (mint.endsWith('BAGS')) return 'Bags';
  if (mint.endsWith('boop')) return 'Boop';
  if (mint.endsWith('moon')) return 'Moonit';
  return null;
}

export function launchpadLabel(dexId, mint, dexName) {
  const fromMint = launchpadFromMint(mint);
  if (fromMint) return fromMint;
  const hay = `${dexId || ''} ${dexName || ''}`.toLowerCase();
  for (const [re, label] of NAME_RULES) if (re.test(hay)) return label;
  // Never show an "Unknown" launchpad - fall back to the venue's own name, or Raydium (the
  // default Solana venue) if the source gave nothing at all.
  const raw = (dexName || dexId || '').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Raydium';
}


function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Launchpad label for a raw Jupiter token record.
export function jupToLabel(t) {
  return launchpadLabel(t.firstPool?.dex, t.id, t.launchpad || (t.partnerConfig ? 'dbc' : ''));
}

function jupToEntry(t) {
  const st = (k) => t[`stats${k}`] || {};
  const ch = (k) => num(st(k).priceChange);
  const tx = (k) => ({ buys: num(st(k).numBuys), sells: num(st(k).numSells) });
  const vol = (k) => num(st(k).buyVolume) + num(st(k).sellVolume);
  const created = t.firstPool?.createdAt ? new Date(t.firstPool.createdAt).getTime() : null;
  return {
    mint: t.id,
    pairAddress: null, // filled in by resolveEntry on click
    symbol: t.symbol || '?',
    name: t.name || t.symbol || '?',
    priceUsd: num(t.usdPrice),
    liquidityUsd: num(t.liquidity),
    volume24h: vol('24h'),
    volume1h: vol('1h'),
    priceChange24h: ch('24h'),
    priceChange: { m5: ch('5m'), h1: ch('1h'), h6: ch('6h'), h24: ch('24h') },
    txns: { m5: tx('5m'), h1: tx('1h'), h6: tx('6h'), h24: tx('24h') },
    pairCreatedAt: created && !Number.isNaN(created) ? created : null,
    marketCap: num(t.mcap) || num(t.fdv),
    marketCapIsFdv: !num(t.mcap),
    iconUrl: t.icon || null,
    dexUrl: null,
    launchpad: launchpadLabel(t.firstPool?.dex, t.id, t.launchpad || (t.partnerConfig ? 'dbc' : '')),
    launchpadRaw: t.launchpad || null, // what Jupiter calls the launchpad (kept so wrong labels can be diagnosed / corrected)
    partnerConfig: t.partnerConfig || null, // identifies the platform on Meteora's bonding-curve program
    // Jupiter's own launchpad field survives migration (the coin may now trade on Raydium/Meteora)
    fromLaunchpad: !!t.launchpad || !!launchpadFromMint(t.id) || LAUNCHPAD_ONLY.has(launchpadLabel(t.firstPool?.dex, t.id, t.launchpad || (t.partnerConfig ? 'dbc' : ''))),
    tags: Array.isArray(t.tags) ? t.tags : [],
    organicScore: t.organicScore == null ? null : num(t.organicScore),
    isSus: t.audit?.isSus === true,
  };
}

async function fetchJupiterList(ctx, path) {
  const json = await ctx.fetchJson(`${JUP}/${path}`);
  if (!Array.isArray(json)) {
    console.info(`[trendingFeed] Jupiter ${path} returned nothing`);
    return [];
  }
  return json.filter((t) => t && t.id).map(jupToEntry);
}

// GeckoTerminal pool lists (new pools, trending pools, top-volume pools, and each launchpad's own pools).
// One parser for all of them. A launchpad's pools are how coins from Stonkfun, Heaven, Candle etc. that
// Jupiter's top lists don't surface (yet) still make it into the lists.
async function fetchGeckoPools(ctx, path) {
  const sep = path.includes('?') ? '&' : '?';
  const json = await ctx.fetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/${path}${sep}include=base_token,dex`);
  if (!json?.data) return [];
  const byRef = new Map((json.included || []).map((i) => [`${i.type}:${i.id}`, i]));
  const out = [];
  for (const pool of json.data) {
    try {
      const a = pool.attributes || {};
      const baseRef = pool.relationships?.base_token?.data;
      const dexRef = pool.relationships?.dex?.data;
      const tok = baseRef ? byRef.get(`${baseRef.type}:${baseRef.id}`) : null;
      const dex = dexRef ? byRef.get(`${dexRef.type}:${dexRef.id}`) : null;
      const mint = tok?.attributes?.address || (baseRef?.id ? baseRef.id.replace(/^solana_/, '') : null);
      if (!mint) continue;
      const pc = (k) => num(a.price_change_percentage?.[k]);
      const tx = (k) => ({ buys: num(a.transactions?.[k]?.buys), sells: num(a.transactions?.[k]?.sells) });
      const icon = tok?.attributes?.image_url;
      const dexId = dex?.id || dexRef?.id;
      const label = launchpadLabel(dexId, mint, dex?.attributes?.name);
      out.push({
        mint,
        pairAddress: a.address || null,
        symbol: tok?.attributes?.symbol || (a.name || '?').split('/')[0].trim(),
        name: tok?.attributes?.name || a.name || '?',
        priceUsd: num(a.base_token_price_usd),
        liquidityUsd: num(a.reserve_in_usd),
        volume24h: num(a.volume_usd?.h24),
        volume1h: num(a.volume_usd?.h1),
        priceChange24h: pc('h24'),
        priceChange: { m5: pc('m5'), h1: pc('h1'), h6: pc('h6'), h24: pc('h24') },
        txns: { m5: tx('m5'), h1: tx('h1'), h6: tx('h6'), h24: tx('h24') },
        pairCreatedAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : null,
        marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
        marketCapIsFdv: !num(a.market_cap_usd),
        iconUrl: icon && !icon.includes('missing') ? icon : null,
        dexUrl: null,
        launchpad: label,
        fromLaunchpad: !!launchpadFromMint(mint) || LAUNCHPAD_ONLY.has(label),
      });
    } catch { /* skip bad pool */ }
  }
  return out;
}
const fetchGeckoNew = (ctx, page) => fetchGeckoPools(ctx, `new_pools?page=${page}`);

// Venues that are only AMMs, not launchpads - a coin trading there could have come from anywhere.
const GENERIC_VENUES = new Set(['Raydium', 'Meteora AMM', 'Meteora AMM V2', 'Orca', 'PancakeSwap']);
export const LAUNCHPAD_ONLY = new Set(ALL_LAUNCHPADS.filter((l) => !GENERIC_VENUES.has(l)));
// Is this GeckoTerminal DEX one of the launchpads we list? (server uses it to pick which DEX pool lists to pull)
export function isLaunchpadDex(id, name) {
  return LAUNCHPAD_ONLY.has(launchpadLabel(id, null, name)) && NAME_RULES.some(([re]) => re.test(`${id || ''} ${name || ''}`.toLowerCase()));
}

// Known non-memecoins (infra, DeFi, wrapped/staked/stable assets, tokenized stocks). Used to keep
// the Top tab to memecoins when CoinGecko's meme ranking isn't available.
const NON_MEME = new Set([
  'JUP', 'PUMP', 'RAY', 'JTO', 'PYTH', 'ORCA', 'W', 'DRIFT', 'KMNO', 'ONDO', 'RENDER', 'RNDR', 'HNT', 'MNDE', 'JLP',
  'JUPSOL', 'JITOSOL', 'MSOL', 'BSOL', 'ZEC', 'ORE', 'MU', 'UMBRA', 'LINK', 'UNI', 'AAVE', 'MORPHO', 'META', 'PENGU_',
  'WBTC', 'BTC', 'WETH', 'ETH', 'CBBTC', 'ZBTC', 'TBTC', 'XAUT', 'PAXG', 'GOLD', 'CRCL', 'IO', 'MOBILE', 'IOT',
  'GRASS', 'SLND', 'MNGO', 'PRCL', 'TNSR', 'ZEUS', 'ME', 'JLP', 'USDC', 'USDT', 'FDUSD', 'EURC', 'BONKSOL',
]);
// Well-known Solana memecoins (fallback identification when CoinGecko's meme list isn't available).
const KNOWN_MEMES = new Set([
  'BONK', 'WIF', 'POPCAT', 'TRUMP', 'MELANIA', 'FARTCOIN', 'PENGU', 'MEW', 'MOODENG', 'GOAT', 'PNUT', 'FWOG', 'GIGA',
  'SPX', 'BOME', 'MICHI', 'RETARDIO', 'USELESS', 'WEN', 'SLERF', 'SC', 'ZEREBRO', 'AI16Z', 'GRIFFAIN', 'ACT', 'CHILLGUY',
  'DADDY', 'BILLY', 'MYRO', 'SAMO', 'PONKE', 'HARAMBE', 'LOCKIN', 'SIGMA', 'TOSHI', 'UFD', 'BAN', 'NEIRO', 'DOGE',
  'SHIB', 'PEPE', 'APU', 'ALCH', 'TREMP', 'JELLYJELLY', 'SNAP', 'STONK', 'BUTTCOIN', 'SELFIE', 'LOUD', 'MUMU', 'DOG',
  'COPE', 'HARRY', 'PWEASE', 'CHEEMS', 'FRED', 'TOBY', 'MANEKI', 'SILLY', 'HOSICO', 'DEGEN', 'PIPPIN', 'FOUR', 'TRENCH',
]);

function isNonMeme(e) {
  const s = (e.symbol || '').trim();
  const u = s.toUpperCase();
  if (NON_MEME.has(u) || BASE_ASSETS.has(u)) return true;
  if (/usd/i.test(s)) return true; // stablecoins
  if (/sol$/i.test(s) && u !== 'SOL' && s.length > 3 && /^[a-z]+SOL$/i.test(s) && /^(j|m|b|h|jup|jito|d|v|lst|pico|ez|inf)/i.test(s)) return true; // staked SOL
  if (/^[A-Z0-9]{2,6}x$/.test(s)) return true; // tokenized stocks (TSLAx, NVDAx ...)
  if (/wrapped|staked|liquid staking|tokenized|xstock/i.test(e.name || '')) return true;
  if ((e.tags || []).some((t) => /stable|lst|wrapped|liquid/i.test(t))) return true;
  return false;
}

// CoinGecko "Solana meme coins" market row -> feed entry (server passes these in via ctx.topMemes).
export function cgToEntry(m, mint) {
  const ch = num(m.price_change_percentage_24h);
  return {
    mint,
    pairAddress: null,
    symbol: (m.symbol || '?').toUpperCase(),
    name: m.name || m.symbol || '?',
    priceUsd: num(m.current_price),
    liquidityUsd: 0, // unknown from CoinGecko; the real liquidity loads when the coin is opened
    volume24h: num(m.total_volume),
    priceChange24h: ch,
    priceChange: { m5: 0, h1: 0, h6: 0, h24: ch },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
    pairCreatedAt: null,
    marketCap: num(m.market_cap),
    marketCapIsFdv: false,
    iconUrl: m.image || null,
    dexUrl: null,
    launchpad: launchpadLabel(null, mint),
    tags: [],
  };
}

// Shared momentum score (also used by the server's trending post-process): money flowing in, trade count, price move, buy pressure.
export function trendMomentum(e) {
  const t = e.txns?.h1 || { buys: 0, sells: 0 }, n = t.buys + t.sells;
  const buyShare = n ? t.buys / n : 0.5;
  const pc = e.priceChange || {};
  const vol = e.volume1h || (e.volume24h || 0) / 12 || 0;
  return Math.log10(1 + vol) + 0.8 * Math.log10(1 + n) + Math.max(-20, Math.min(150, pc.h1 || 0)) / 60 + (buyShare - 0.5) * 2 + Math.max(-10, Math.min(60, pc.m5 || 0)) / 30;
}

export async function buildFeed(ctx) {
  const dexIds = ctx.launchpadDexes ? await ctx.launchpadDexes().catch(() => []) : [];
  const [trend5, trend1h, traded1h, tradedRaw, recentRaw, organicRaw, geckoNew1, geckoNew2, memes,
    trend6h, trend24h, traded6h, geckoTrend1, geckoTrend2, organic6h, organic1h, geckoTrend5m, geckoTrend1h, ...geckoTopPages] = await Promise.all([
    fetchJupiterList(ctx, 'toptrending/5m?limit=100'),
    fetchJupiterList(ctx, 'toptrending/1h?limit=100'),
    fetchJupiterList(ctx, 'toptraded/1h?limit=100'),
    fetchJupiterList(ctx, 'toptraded/24h?limit=100'),
    fetchJupiterList(ctx, 'recent?limit=100'),
    fetchJupiterList(ctx, 'toporganicscore/24h?limit=100'),
    fetchGeckoNew(ctx, 1),
    fetchGeckoNew(ctx, 2),
    ctx.topMemes ? ctx.topMemes().catch(() => []) : Promise.resolve([]),
    // wider nets so coins that aren't in the short top-100 lists still appear
    fetchJupiterList(ctx, 'toptrending/6h?limit=100'),
    fetchJupiterList(ctx, 'toptrending/24h?limit=100'),
    fetchJupiterList(ctx, 'toptraded/6h?limit=100'),
    fetchGeckoPools(ctx, 'trending_pools?page=1'),
    fetchGeckoPools(ctx, 'trending_pools?page=2'),
    fetchJupiterList(ctx, 'toporganicscore/6h?limit=100'),
    fetchJupiterList(ctx, 'toporganicscore/1h?limit=100'),
    fetchGeckoPools(ctx, 'trending_pools?duration=5m'),
    fetchGeckoPools(ctx, 'trending_pools?duration=1h'),
    // the 160 highest-volume Solana pools - nearly every $10M+ coin trades enough to be in here
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => fetchGeckoPools(ctx, `pools?page=${n}&sort=h24_volume_usd_desc`)),
    // every launchpad's own pool list (Stonkfun, Heaven, Candle, Bags ...), one call each
    ...dexIds.slice(0, 16).map((id) => fetchGeckoPools(ctx, `dexes/${id}/pools?page=1`).catch(() => [])),
  ]);
  const geckoTopAll = geckoTopPages.slice(0, 8).flat();
  const dexPools = geckoTopPages.slice(8).flat();
  console.info(`[trendingFeed] Jupiter: trending5m ${trend5.length}, trending1h ${trend1h.length}, traded ${tradedRaw.length}, recent ${recentRaw.length}; meme ranking ${memes.length}`);

  const ok = (e) => e.liquidityUsd >= MIN_LIQUIDITY_USD && e.priceChange24h > -MAX_DROP_PCT;
  const dedupe = (list) => { const seen = new Set(); return list.filter((e) => !seen.has(e.mint) && seen.add(e.mint)); };

  // GeckoTerminal pools say which AMM a coin trades on, not where it was born. For big coins that only
  // showed up there (e.g. a migrated Stonkfun coin sitting on Raydium), ask Jupiter - it remembers the
  // launchpad - so they can be recognised as memecoins instead of being dropped.
  const jupKnown = new Map();
  for (const l of [trend5, trend1h, traded1h, tradedRaw, recentRaw, organicRaw, trend6h, trend24h, traded6h, organic6h, organic1h]) for (const e of l) jupKnown.set(e.mint, e);
  const geckoBig = dedupe([...geckoTopAll, ...geckoTrend1, ...geckoTrend2, ...geckoTrend5m, ...geckoTrend1h, ...dexPools, ...geckoNew1, ...geckoNew2]
    .filter((e) => e.marketCap >= 8e6 && !jupKnown.has(e.mint) && !isNonMeme(e)))
    .sort((a, b) => b.marketCap - a.marketCap).slice(0, 100);
  let enriched = [];
  if (geckoBig.length) enriched = await fetchJupiterList(ctx, `search?query=${geckoBig.map((e) => e.mint).join(',')}`).catch(() => []);
  const enrichedMap = new Map(enriched.map((e) => [e.mint, e]));
  // use Jupiter's record when it has one (launchpad known); otherwise keep Gecko's
  const upgrade = (e) => (enrichedMap.has(e.mint) ? { ...e, ...enrichedMap.get(e.mint), pairAddress: e.pairAddress, volume24h: e.volume24h || enrichedMap.get(e.mint).volume24h } : e);
  const geckoLists = [geckoTopAll, geckoTrend1, geckoTrend2, geckoTrend5m, geckoTrend1h, dexPools].map((l) => l.map(upgrade));
  const [gTop, gT1, gT2, gT5, gT1h, gDex] = geckoLists;

  // Trending = rank blend (what the trending lists say) mixed with real momentum measured from the
  // numbers: money flowing in the last hour, trade count, price move and buy pressure.
  // "Trending" means the chart is actively moving with real two-sided trading - not a huge-cap
  // honeypot with no liquidity behind it. Strict check first, relaxed if too few coins pass.
  const score = new Map();
  const entryOf = new Map();
  const active = (e, strict) => {
    const t1 = e.txns.h1, t5 = e.txns.m5;
    const n1 = t1.buys + t1.sells, n5 = t5.buys + t5.sells;
    if (e.isSus || isNonMeme(e)) return false;
    // Kept deliberately light: only drop dead charts, obvious honeypots and thin-liquidity junk.
    // The ranking itself (below) is what decides who is on top.
    // coins that are dumping or already rugged are not "trending"
    if (e.priceChange.h1 <= -40 || e.priceChange.h6 <= -60 || e.priceChange24h <= -70) return false;
    if (t1.sells > 30 && t1.sells > t1.buys * 3 && e.priceChange.h1 < 0) return false; // heavy sell-off
    if (e.marketCap >= 1e6 && e.liquidityUsd > 0.8 * e.marketCap) return false; // fake pool
    if (e.liquidityUsd < (strict ? 3000 : 1500)) return false;
    if (n1 < (strict ? 20 : 8) && n5 < (strict ? 4 : 2)) return false; // dead chart
    if (t1.buys >= 20 && t1.sells < t1.buys * 0.1) return false; // can't sell = honeypot
    if (e.marketCap > 0 && e.marketCap / e.liquidityUsd > 1000) return false; // absurd fake cap
    return true;
  };
  const rankLists = [
    [trend5, 1.6], [gT5, 1.4], [trend1h, 1.0], [gT1h, 0.9], [traded1h, 0.6], [gT1.concat(gT2), 0.8], [trend6h, 0.4],
    [gDex.slice().sort((a, b) => b.volume1h - a.volume1h || b.volume24h - a.volume24h), 0.5],
  ];
  const build = (strict) => {
    score.clear(); entryOf.clear();
    for (const [list, weight] of rankLists) {
      list.forEach((e, i) => {
        if (!ok(e) || !active(e, strict)) return;
        entryOf.set(e.mint, entryOf.get(e.mint) || e);
        score.set(e.mint, (score.get(e.mint) || 0) + weight / (i + 4));
      });
    }
  };
  build(true);
  if (entryOf.size < 10) build(false);
  const momentum = (e) => {
    const t = e.txns.h1, n = t.buys + t.sells;
    const buyShare = n ? t.buys / n : 0.5;
    const vol = e.volume1h || e.volume24h / 12 || 0;
    return Math.log10(1 + vol) + 0.8 * Math.log10(1 + n) + Math.max(-20, Math.min(150, e.priceChange.h1)) / 60 + (buyShare - 0.5) * 2
      + Math.max(-10, Math.min(60, e.priceChange.m5)) / 30;
  };
  const entries = [...entryOf.values()];
  const maxRank = Math.max(...entries.map((e) => score.get(e.mint)), 1e-9);
  const moms = entries.map(momentum);
  const minMom = Math.min(...moms, 0), maxMom = Math.max(...moms, 1);
  // Mostly the trending lists' own ranking (Jupiter + GeckoTerminal, like Fomo/Dex trending); momentum only breaks ties.
  const finalScore = new Map(entries.map((e, i) => [e.mint, 0.8 * (score.get(e.mint) / maxRank) + 0.2 * ((moms[i] - minMom) / (maxMom - minMom || 1))]));
  // any age counts: an older coin that is suddenly running IS trending. Brand-new coins get a small nudge.
  const DAY = 24 * 3600 * 1000;
  const boost = () => 0;
  const trending = entries.sort((a, b) => (finalScore.get(b.mint) + boost(b)) - (finalScore.get(a.mint) + boost(a))).slice(0, COLUMN_LIMIT);

  // Movers: small/mid caps that are running right now, any age. Feeds the early-gem scanner so it can
  // catch an older coin that suddenly breaks out - not only brand-new launches.
  const movers = dedupe([...trend5, ...gT5, ...trend1h, ...gT1h, ...traded1h, ...gT1, ...gT2, ...gDex].filter((e) =>
    !isNonMeme(e) && !e.isSus && e.liquidityUsd >= 3000 && e.marketCap > 0 && e.marketCap <= 5e6
    && (e.priceChange.h1 >= 25 || e.priceChange.m5 >= 8) && e.txns.h1.buys + e.txns.h1.sells >= 30))
    .sort((a, b) => momentum(b) - momentum(a)).slice(0, 80);

  // New: freshest launches first, from Jupiter "recent" + GeckoTerminal new pools (seconds/minutes old).
  const freshOk = (e) => e.liquidityUsd >= 300 && e.priceChange24h > -MAX_DROP_PCT && e.pairCreatedAt;
  const newPairs = dedupe([...recentRaw, ...geckoNew1, ...geckoNew2, ...gDex].filter(freshOk))
    .sort((a, b) => b.pairCreatedAt - a.pairCreatedAt)
    .slice(0, COLUMN_LIMIT);

  // Top: highest market-cap MEMECOINS, $10M and up. An allowlist - a coin must be positively identified
  // as a memecoin (CoinGecko's meme list, born on a launchpad - Jupiter remembers this after migration -
  // a launchpad mint suffix, or a well-known meme) so stablecoins, wrapped assets, tokenized stocks and
  // DeFi tokens can't slip in.
  const bigPool = [...tradedRaw, ...traded6h, ...organicRaw, ...organic6h, ...organic1h, ...trend1h, ...trend5, ...trend6h, ...trend24h, ...traded1h,
    ...gTop, ...gT1, ...gT2, ...gT5, ...gT1h, ...gDex, ...enriched]
    .filter((e) => e.marketCap > 0 && e.liquidityUsd >= MIN_LIQUIDITY_USD && e.priceChange24h > -MAX_DROP_PCT && !isNonMeme(e));
  const isMeme = (e) => e.fromLaunchpad || launchpadFromMint(e.mint) || KNOWN_MEMES.has((e.symbol || '').toUpperCase());
  const memePool = [
    ...memes.filter((e) => !isNonMeme(e)),
    ...bigPool.filter(isMeme),
  ];
  const top = cleanTop(dedupe(memePool).filter((e) => e.marketCap >= TOP_MIN_MCAP)).slice(0, TOP_LIMIT);

  return { newPairs, trending, top, movers, launchpads: ALL_LAUNCHPADS };
}

// DexScreener pair -> feed entry (used to keep big coins' numbers fresh once we know they exist).
export function dexPairToEntry(p, meta = {}) {
  const ch = (k) => num(p.priceChange?.[k]);
  const tx = (k) => ({ buys: num(p.txns?.[k]?.buys), sells: num(p.txns?.[k]?.sells) });
  const mint = p.baseToken?.address;
  return {
    mint,
    pairAddress: p.pairAddress || null,
    symbol: p.baseToken?.symbol || meta.symbol || '?',
    name: p.baseToken?.name || meta.name || '?',
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd),
    volume24h: num(p.volume?.h24),
    volume1h: num(p.volume?.h1),
    priceChange24h: ch('h24'),
    priceChange: { m5: ch('m5'), h1: ch('h1'), h6: ch('h6'), h24: ch('h24') },
    txns: { m5: tx('m5'), h1: tx('h1'), h6: tx('h6'), h24: tx('h24') },
    pairCreatedAt: p.pairCreatedAt || null,
    marketCap: num(p.marketCap) || num(p.fdv),
    marketCapIsFdv: !num(p.marketCap),
    iconUrl: p.info?.imageUrl || meta.iconUrl || null,
    dexUrl: p.url || null,
    launchpad: meta.launchpad || launchpadLabel(p.dexId, mint),
    partnerConfig: meta.partnerConfig || null,
    fromLaunchpad: true,
    tags: [],
  };
}


// ---- Fake / copycat market protection (shared by the feed builder and the server) ----
// A copycat token can show a huge market cap and "liquidity" from one-sided pools nobody trades.
// Real coins at $10M+ always have real 24h volume and liquidity far below their market cap.
export function isFakeMarket(e) {
  if (!(e.marketCap > 0)) return false;
  if (e.volume24h != null && e.volume24h < 10000) return true; // nobody is trading it ($2 of volume etc.)
  if (e.marketCap >= 5e6 && e.liquidityUsd > 0.8 * e.marketCap) return true; // liquidity ~ market cap = fake pool
  return false;
}

// One feed entry for a mint from ALL of its DexScreener pairs. Price / market cap / activity come from the
// pair that actually trades (most 24h volume), not from the pair with the biggest (possibly fake) liquidity.
export function aggregatePairs(pairs, meta = {}) {
  const list = (pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address);
  if (!list.length) return null;
  const vol = (p) => num(p.volume?.h24);
  const best = list.slice().sort((a, b) => vol(b) - vol(a) || num(b.liquidity?.usd) - num(a.liquidity?.usd))[0];
  const totalVol = list.reduce((s, p) => s + vol(p), 0);
  const entry = dexPairToEntry(best, meta);
  entry.volume24h = totalVol;
  // count liquidity only from pairs that really trade (>= 0.5% of the coin's volume)
  entry.liquidityUsd = list.filter((p) => totalVol > 0 && vol(p) >= totalVol * 0.005).reduce((s, p) => s + num(p.liquidity?.usd), 0) || num(best.liquidity?.usd);
  return entry;
}

// Drop fake markets, then keep only ONE token per ticker: the one with the real trading (volume), then the oldest.
export function cleanTop(list) {
  const real = list.filter((e) => !isFakeMarket(e));
  const bySym = new Map();
  for (const e of real) {
    const k = String(e.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cur = bySym.get(k);
    const better = !cur || (e.volume24h || 0) > (cur.volume24h || 0) * 1.05
      || ((e.volume24h || 0) >= (cur.volume24h || 0) * 0.95 && (e.pairCreatedAt || Infinity) < (cur.pairCreatedAt || Infinity));
    if (!k || better) bySym.set(k || e.mint, e);
  }
  const keep = new Set([...bySym.values()].map((e) => e.mint));
  return real.filter((e) => keep.has(e.mint)).sort((a, b) => b.marketCap - a.marketCap);
}

// Trending sanity that can also run in the browser, so a stale server can't show these.
export function isDumpingOrFake(e) {
  const pc = e.priceChange || {};
  if (pc.h1 <= -40 || pc.h6 <= -60 || (e.priceChange24h ?? 0) <= -70) return true;
  const t1 = e.txns?.h1 || { buys: 0, sells: 0 };
  if (t1.sells > 30 && t1.sells > t1.buys * 3 && pc.h1 < 0) return true;
  if (e.marketCap >= 1e6 && e.liquidityUsd > 0.8 * e.marketCap) return true;
  return isFakeMarket(e);
}
