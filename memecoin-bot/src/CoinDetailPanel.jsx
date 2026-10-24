import { api } from './api';
import { useState, useEffect } from 'react';
import { usePaperTrading } from './PaperTradingContext';
import { CoinTradeHistory } from './TradeLog';
import { fetchRugCheckSummary } from './rugcheck';
import CoinIcon from './CoinIcon';
import { fullVerdict } from './rugAnalysis';

function formatMC(val, isFdv) {
  if (!val || val <= 0) return 'N/A';
  const suffix = isFdv ? ' (FDV)' : '';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B${suffix}`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M${suffix}`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K${suffix}`;
  return `$${val.toFixed(0)}${suffix}`;
}

function formatAge(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function CoinDetailPanel({ coin: rawCoin, onBack }) {
  // positions opened from older versions can carry partial coin data - fill the gaps so the page never breaks
  const coin = rawCoin
    ? { name: rawCoin.symbol, priceUsd: 0, liquidityUsd: 0, volume24h: 0, priceChange24h: 0, priceChange: {}, txns: {}, ...rawCoin }
    : rawCoin;
  const { closedTrades, positions, livePrices, setViewingCoin, startFarming, buyNowSkipAnalysis, closePosition, balance, settings } = usePaperTrading();
  const [budgetInput, setBudgetInput] = useState('100');
  const [buyAmountInput, setBuyAmountInput] = useState('25');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [message, setMessage] = useState('');
  const [rc, setRc] = useState({ loading: true, data: null });
  const [lp, setLp] = useState(null); // { label, taught } from the server (Jupiter + corrections you taught it)
  const [lpNote, setLpNote] = useState('');
  const [caNote, setCaNote] = useState('');

  useEffect(() => {
    if (!coin) {
      setViewingCoin(null);
      return;
    }
    setViewingCoin({ mint: coin.mint, pairAddress: coin.pairAddress });
    return () => setViewingCoin(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin?.mint]);

  // Launchpad is detected automatically (never picked by hand). If the data only tells us the exchange
  // the coin trades on, say so instead of guessing a launchpad.
  const VENUES = new Set(['Raydium', 'Meteora AMM', 'Meteora AMM V2', 'Orca', 'PancakeSwap', 'PumpSwap']);
  const lpLabel = lp?.label || coin?.launchpad || '';
  const lpText = !lpLabel ? 'detecting...' : VENUES.has(lpLabel) ? `Unknown (trades on ${lpLabel})` : lpLabel;

  // Launchpad: ask the server (Jupiter's launchpad data + anything you corrected earlier)
  useEffect(() => {
    if (!coin?.mint) return;
    let cancelled = false;
    setLp(null);
    setLpNote('');
    api.launchpadOf(coin.mint).then((r) => { if (!cancelled && r?.label) setLp(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [coin?.mint]);

  // Coin info (dev holding, bundles, holders, authorities) from RugCheck - cached for 2 minutes
  useEffect(() => {
    if (!coin?.mint) return;
    let cancelled = false;
    setRc({ loading: true, data: null });
    fetchRugCheckSummary(coin.mint).then((data) => {
      if (!cancelled) setRc({ loading: false, data });
    });
    // keep dev / bundle / holder numbers fresh while the coin is open - no need to close and reopen it
    const id = setInterval(() => {
      fetchRugCheckSummary(coin.mint, 8000).then((data) => {
        if (!cancelled && data) setRc({ loading: false, data });
      });
    }, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [coin?.mint]);

  if (!coin) return null;

  // One farm per coin - find it by mint regardless of whether we got here via search or
  // by clicking an existing position in the list.
  const position = positions.find((p) => p.mint === coin.mint) || null;
  const isWaiting = position && position.tokensHeld === 0;
  const isActive = position && position.tokensHeld > 0;

  const live = livePrices[coin.mint];
  const displayPrice = position ? position.currentPrice : (live?.priceUsd ?? coin.priceUsd);
  const displayMc = position ? position.currentMarketCap : (live?.marketCap ?? (coin.marketCap || coin.fdv || 0));
  const displayMcIsFdv = position ? position.currentMarketCapIsFdv : (live?.isFdv ?? coin.marketCapIsFdv ?? false);

  const drawdownPct = position ? ((position.referenceHigh - position.currentPrice) / position.referenceHigh) * 100 : 0;
  const heldValue = position ? position.tokensHeld * position.currentPrice : 0;
  const unrealizedPnl = position ? (position.currentPrice - position.avgCostBasis) * position.tokensHeld : 0;
  const totalPnl = position ? position.realizedPnlUsd + unrealizedPnl : 0;
  const totalPnlPct = position && position.budgetUsd > 0 ? (totalPnl / position.budgetUsd) * 100 : 0;

  async function handleStartFarming() {
    const budgetUsd = parseFloat(budgetInput);
    if (!budgetUsd || budgetUsd <= 0) {
      setMessage('Enter a valid budget amount.');
      return;
    }
    if (budgetUsd > balance) {
      setMessage(`Not enough paper balance (you have $${balance.toFixed(2)}).`);
      return;
    }
    setAnalyzing(true);
    setMessage('');
    const result = await startFarming(coin, budgetUsd);
    setAnalysis(result);
    setAnalyzing(false);
  }

  function handleBuyNow() {
    const budgetUsd = parseFloat(budgetInput);
    const buyAmountUsd = parseFloat(buyAmountInput);
    if (!position && (!budgetUsd || budgetUsd <= 0)) {
      setMessage('Enter a valid budget amount.');
      return;
    }
    if (!position && budgetUsd > balance) {
      setMessage(`Not enough paper balance (you have $${balance.toFixed(2)}).`);
      return;
    }
    if (!buyAmountUsd || buyAmountUsd <= 0) {
      setMessage('Enter a valid amount to buy right now.');
      return;
    }
    const availableForThisBuy = position ? position.availableCash : budgetUsd;
    if (buyAmountUsd > availableForThisBuy) {
      setMessage(`That's more than what's available ($${availableForThisBuy.toFixed(2)}). It'll be capped to that.`);
    }
    buyNowSkipAnalysis(coin, budgetUsd, buyAmountUsd);
    setMessage(`Bought $${Math.min(buyAmountUsd, availableForThisBuy).toFixed(2)} of ${coin.symbol} right now.`);
    setAnalysis(null);
  }

  function handleClose() {
    if (!position) return;
    closePosition(position.id);
  }

  function openXSearch() {
    const query = encodeURIComponent(`${coin.symbol} ${coin.mint}`);
    window.open(`https://x.com/search?q=${query}&src=typed_query&f=live`, '_blank');
  }

  return (
    <div style={{ maxWidth: '100%', margin: '20px 0', padding: 16, border: '1px solid #223247', borderRadius: 8, background: '#111a26', boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px' }}>
      {onBack && (
        <button onClick={onBack} style={{ marginBottom: 12, fontSize: 13 }}>
          ← Back to Menu
        </button>
      )}
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <CoinIcon mint={coin.mint} src={coin.iconUrl} symbol={coin.symbol} size={32} />
        {coin.symbol} <span style={{ color: '#8296ad', fontWeight: 'normal' }}>({coin.name})</span>
        {isActive && <span style={{ fontSize: 12, color: '#3ddc97', border: '1px solid #3ddc97', borderRadius: 4, padding: '2px 8px' }}>Active</span>}
        {isWaiting && <span style={{ fontSize: 12, color: '#5ec8ff', border: '1px solid #5ec8ff', borderRadius: 4, padding: '2px 8px' }}>Waiting for Entry</span>}
      </h3>

      <div style={{ fontSize: 24, fontWeight: 'bold', color: '#5ec8ff', marginBottom: 8 }}>
        MC: {formatMC(displayMc, displayMcIsFdv)}
      </div>

      {isActive && (
        <div style={{ marginBottom: 12, padding: 10, background: '#162233', borderRadius: 8, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Budget / Available</div>
            <div>${position.budgetUsd.toFixed(2)} / ${position.availableCash.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Holding Value</div>
            <div>${heldValue.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Avg Cost</div>
            <div>${position.avgCostBasis.toFixed(8)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Unrealized (still holding)</div>
            <div style={{ color: unrealizedPnl >= 0 ? '#3ddc97' : '#ff5d6c', fontWeight: 'bold' }}>{unrealizedPnl >= 0 ? '+' : '-'}${Math.abs(unrealizedPnl).toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Realized (sold)</div>
            <div style={{ color: position.realizedPnlUsd >= 0 ? '#3ddc97' : '#ff5d6c', fontWeight: 'bold' }}>{position.realizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(position.realizedPnlUsd).toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8296ad' }}>Total PnL (realized + unrealized)</div>
            <div style={{ color: totalPnl >= 0 ? '#3ddc97' : '#ff5d6c', fontWeight: 'bold' }}>
              {totalPnlPct.toFixed(2)}% (${totalPnl.toFixed(2)})
            </div>
          </div>
          <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
            <button onClick={handleClose}>Close Position</button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: '#aaa' }}>Price: ${displayPrice < 0.01 ? displayPrice.toFixed(8) : displayPrice.toFixed(4)}</div>
      <div style={{ fontSize: 13, color: '#aaa' }}>24h change: <span style={{ color: coin.priceChange24h >= 0 ? '#3ddc97' : '#ff5d6c' }}>{coin.priceChange24h?.toFixed(2)}%</span></div>
      <div style={{ fontSize: 13, color: '#aaa' }}>Liquidity: ${coin.liquidityUsd.toLocaleString('en-US')}</div>
      <div style={{ fontSize: 13, color: '#aaa' }}>24h volume: ${coin.volume24h.toLocaleString('en-US')}</div>
      {coin.txns?.h24 && (coin.txns.h24.buys + coin.txns.h24.sells) > 0 && (
        <div style={{ fontSize: 13, color: '#aaa' }}>24h buys/sells: {coin.txns.h24.buys} buys / {coin.txns.h24.sells} sells</div>
      )}

      {(() => {
        const verdict = fullVerdict({ rc: rc.data, marketCap: coin.marketCap, liquidityUsd: coin.liquidityUsd, volume24h: coin.volume24h });
        const vColor = { low: '#3ddc97', medium: '#ffb74d', high: '#ff5d6c', rugged: '#ff5d6c', unknown: '#8296ad' }[verdict.level];
        const vText = { low: 'LOW RISK', medium: 'MEDIUM RISK', high: 'HIGH RISK', rugged: 'RUGGED', unknown: 'UNKNOWN' }[verdict.level];
        const d = rc.data;
        return (
          <div style={{ marginTop: 12, padding: 10, background: '#162233', borderRadius: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontWeight: 'bold', color: '#5ec8ff' }}>Coin info</span>
              {!rc.loading && <span style={{ fontWeight: 'bold', color: vColor }}>{vText}{d?.riskScore != null ? ` · RugCheck ${Math.round(d.riskScore)}/100 (higher = riskier)` : ''}</span>}
            </div>
            {verdict.reasons.length > 0 && !rc.loading && (
              <ul style={{ margin: '0 0 8px 16px', padding: 0, color: '#bbb' }}>
                {verdict.reasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '4px 16px', color: '#aaa' }}>
              <div>
                Launchpad: <span style={{ color: '#eee' }}>{lpText}</span>
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>CA:</span>
                <code style={{ color: '#eee', fontSize: 12, wordBreak: 'break-all' }}>{coin.mint}</code>
                <button
                  onClick={() => { try { navigator.clipboard.writeText(coin.mint); setCaNote('Copied'); } catch { setCaNote('Copy failed'); } setTimeout(() => setCaNote(''), 1500); }}
                  style={{ padding: '1px 8px', fontSize: 11 }}
                >Copy</button>
                <button
                  title="Always list this coin in Top once it is $10M+"
                  onClick={() => api.pinCoin(coin.mint).then(() => setCaNote('Pinned - it will show in Top when over $10M')).catch((e) => setCaNote(e.message || 'Could not pin'))}
                  style={{ padding: '1px 8px', fontSize: 11 }}
                >📌 Pin to Top</button>
                {caNote && <span style={{ fontSize: 11, color: '#8296ad' }}>{caNote}</span>}
              </div>
              {coin.pairCreatedAt ? <div>Age: <span style={{ color: '#eee' }}>{formatAge(coin.pairCreatedAt)}</span></div> : null}
              {rc.loading && <div>Dev / bundles / holders: <span style={{ color: '#8296ad' }}>loading...</span></div>}
              {!rc.loading && !d && <div style={{ gridColumn: '1 / -1' }}>Dev / bundle / holder data unavailable right now (RugCheck didn't answer).</div>}
              {d && (
                <>
                  <div>Dev holding: <span style={{ color: d.devPct > 10 ? '#ff5d6c' : '#eee' }}>{d.devPct == null ? 'n/a' : d.devPct === 0 ? 'not in top holders (~0%)' : `${d.devPct.toFixed(2)}%`}</span></div>
                  <div>
                    Bundled / insider wallets:{' '}
                    <span style={{ color: d.insiderHoldingPct >= 20 ? '#ff5d6c' : d.insiderWallets > 0 ? '#ffb74d' : '#eee' }}>
                      {d.insiderWallets > 0
                        ? `${d.insiderWallets.toLocaleString('en-US')}${d.insiderHoldingPct > 0 ? ` · ${d.insiderHoldingPct.toFixed(1)}% of supply` : ''}`
                        : 'none detected'}
                    </span>
                  </div>
                  <div>Top 10 holders: <span style={{ color: d.top10Pct > 40 ? '#ffb74d' : '#eee' }}>{d.top10Pct == null ? 'n/a' : `${d.top10Pct.toFixed(1)}%`}</span></div>
                  {d.totalHolders != null && <div>Total holders: <span style={{ color: '#eee' }}>{Number(d.totalHolders).toLocaleString('en-US')}</span></div>}
                  {d.lpLockedPct != null && <div>LP locked/burned: <span style={{ color: d.lpLockedPct >= 90 ? '#3ddc97' : '#ffb74d' }}>{d.lpLockedPct.toFixed(0)}%</span></div>}
                  <div>Mint authority: <span style={{ color: d.mintAuthorityActive ? '#ff5d6c' : '#3ddc97' }}>{d.mintAuthorityActive ? 'still active' : 'revoked'}</span></div>
                  <div>Freeze authority: <span style={{ color: d.freezeAuthorityActive ? '#ff5d6c' : '#3ddc97' }}>{d.freezeAuthorityActive ? 'still active' : 'revoked'}</span></div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      <button onClick={openXSearch} style={{ marginTop: 10, fontSize: 12 }}>
        Check X/Twitter for hype ↗
      </button>
      <div style={{ fontSize: 11, color: '#8296ad', marginTop: 4 }}>
        Opens a live X search in a new tab - not automated, use as a manual gut-check.
      </div>

      {coin.pairAddress && (
        <div style={{ marginTop: 16 }}>
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #223247' }}>
            <iframe
              key={coin.pairAddress}
              src={`https://dexscreener.com/solana/${coin.pairAddress}?embed=1&theme=dark&trades=0&info=0`}
              title={`${coin.symbol} live chart`}
              width="100%"
              height="400"
              style={{ border: 'none' }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#8296ad', marginTop: 4 }}>
            Chart not loading? Some very new or thin pairs don't render in the embed -{' '}
            <a href={`https://dexscreener.com/solana/${coin.pairAddress}`} target="_blank" rel="noreferrer" style={{ color: '#5ec8ff' }}>
              open it directly on DexScreener ↗
            </a>
          </div>
        </div>
      )}
      {!coin.pairAddress && (
        <div style={{ marginTop: 16, fontSize: 13, color: '#ff5d6c' }}>
          No pair address for this coin, so no chart can be shown. Try re-searching it.
        </div>
      )}

      <CoinTradeHistory mint={coin.mint} symbol={coin.symbol} position={position} closedTrades={closedTrades} />

      <div style={{ marginTop: 16, padding: 12, background: '#162233', borderRadius: 8 }}>
        {isWaiting ? (
          <>
            <div style={{ fontWeight: 'bold', color: '#5ec8ff' }}>Analyzing {coin.symbol}...</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Budget: ${position.budgetUsd.toFixed(2)} &nbsp;|&nbsp; Pullback from high: <strong>{drawdownPct.toFixed(2)}%</strong> (buys tranche at {settings.dipBuyThresholdPct}%)
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Also watching 5-minute candles for a +{settings.spikeThresholdPct}% move with buys outnumbering
              sells {settings.spikeBuyDominanceRatio}:1+. First tranche buys on whichever hits first.
            </div>
            <button onClick={handleClose} style={{ marginTop: 10 }}>
              Cancel (Return ${position.budgetUsd.toFixed(2)} to Balance)
            </button>

            <div style={{ marginTop: 12, borderTop: '1px solid #223247', paddingTop: 10 }}>
              <label style={{ fontSize: 13 }}>
                Buy extra now instead of waiting ($):
                <input
                  type="number"
                  value={buyAmountInput}
                  onChange={(e) => setBuyAmountInput(e.target.value)}
                  style={{ marginLeft: 8, width: 90, padding: 6 }}
                />
              </label>
              <button onClick={handleBuyNow} style={{ marginLeft: 8, fontSize: 12 }}>Buy Now</button>
              <span style={{ marginLeft: 8, fontSize: 11, color: '#8296ad' }}>(available: ${position.availableCash.toFixed(2)})</span>
            </div>
          </>
        ) : isActive ? (
          <div style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 'bold', color: '#3ddc97', marginBottom: 4 }}>
              Actively farming - buys tranches on dips/spikes, sells tranches on pumps, repeats until you close it.
            </div>
            Next buy trigger: -{settings.dipBuyThresholdPct}% pullback (or a spike) &nbsp;|&nbsp;
            Next sell trigger: +{settings.takeProfitPct}% pump &nbsp;|&nbsp;
            Hard stop-loss: -{settings.stopLossPct}% from avg cost (full close)

            {position.availableCash > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid #223247', paddingTop: 10 }}>
                <label>
                  Buy extra now instead of waiting ($):
                  <input
                    type="number"
                    value={buyAmountInput}
                    onChange={(e) => setBuyAmountInput(e.target.value)}
                    style={{ marginLeft: 8, width: 90, padding: 6 }}
                  />
                </label>
                <button onClick={handleBuyNow} style={{ marginLeft: 8, fontSize: 12 }}>Buy Now</button>
                <span style={{ marginLeft: 8, fontSize: 11, color: '#8296ad' }}>(available: ${position.availableCash.toFixed(2)})</span>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 10 }}>
              <label>
                Budget to allocate ($):
                <input
                  type="number"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  style={{ marginLeft: 8, width: 100, padding: 6 }}
                />
              </label>
              <span style={{ marginLeft: 8, fontSize: 12, color: '#8296ad' }}>(balance: ${balance.toFixed(2)})</span>
            </div>

            <button onClick={handleStartFarming} disabled={analyzing}>
              {analyzing ? 'Analyzing (checking RugCheck + chart data)...' : 'Start Farming (Analyze → Scale In on Dips/Spikes → Scale Out on Pumps)'}
            </button>

            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 13 }}>
                Or skip analysis and buy this amount now ($):
                <input
                  type="number"
                  value={buyAmountInput}
                  onChange={(e) => setBuyAmountInput(e.target.value)}
                  style={{ marginLeft: 8, width: 90, padding: 6 }}
                />
              </label>
              <button onClick={handleBuyNow} style={{ marginLeft: 8, fontSize: 12 }} disabled={analyzing}>
                Buy Now
              </button>
              <div style={{ fontSize: 11, color: '#8296ad', marginTop: 2 }}>
                The rest of the ${budgetInput || '0'} budget stays available for automatic dip/spike tranche buys later.
              </div>
            </div>

            {analysis && !analysis.passed && (
              <div style={{ marginTop: 10, color: '#ff5d6c', fontSize: 13 }}>
                <div style={{ fontWeight: 'bold' }}>Analysis failed - not farming this coin:</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {analysis.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                <div style={{ color: '#8296ad' }}>You can still "Buy Now" above to override this manually.</div>
              </div>
            )}
            {analysis && analysis.passed && analysis.warnings.length > 0 && (
              <div style={{ marginTop: 10, color: '#ffb74d', fontSize: 13 }}>
                <div style={{ fontWeight: 'bold' }}>Passed with warnings:</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      {message && <div style={{ marginTop: 10, fontSize: 13, color: '#3ddc97' }}>{message}</div>}
    </div>
  );
}
