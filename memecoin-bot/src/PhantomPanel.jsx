import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { usePhantom } from './PhantomContext';
import CoinIcon from './CoinIcon';

const usd = (n) => (n == null || Number.isNaN(n) ? '-' : `$${Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)}`);
const ago = (t) => { if (!t) return ''; const s = Math.max(0, Date.now() / 1000 - t); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const card = { border: '1px solid #2e303a', borderRadius: 10, padding: 12, margin: '10px auto', maxWidth: 760, textAlign: 'left', background: '#1b1c24' };

export default function PhantomPanel() {
  const { address, wallet, ledger, error, syncing, settings, setSettings, proposals, approve, dismiss, refresh } = usePhantom();

  const toggleLive = (on) => {
    if (on && !window.confirm('Turn on REAL-MONEY mode?\n\nWhen the bot buys or sells, you will get a proposal here. Nothing is sent until YOU press Approve AND confirm in Phantom. Only tokens the bot bought this way are ever sold by the bot. Trades are capped per proposal.\n\nContinue?')) return;
    setSettings({ live: on });
  };

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ textAlign: 'center' }}><WalletMultiButton /></div>
      {!address && <p style={{ color: '#aaa', textAlign: 'center', fontSize: 13 }}>Connect Phantom to see your real holdings here and mirror trades you make in Phantom.</p>}

      {address && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <b>Phantom wallet</b>
              <span style={{ color: '#888', fontSize: 12 }}>{address.slice(0, 4)}...{address.slice(-4)} {syncing ? '· syncing' : ''} <button onClick={refresh} style={{ marginLeft: 6, padding: '2px 8px', fontSize: 12 }}>Refresh</button></span>
            </div>
            {error && <div style={{ color: '#f44336', fontSize: 12, marginTop: 4 }}>{error}</div>}
            {wallet && <div style={{ marginTop: 6 }}>SOL: <b>{wallet.sol.toFixed(4)}</b>{wallet.solUsd ? <span style={{ color: '#888' }}> ({usd(wallet.sol * wallet.solUsd)})</span> : null}</div>}
          </div>

          <div style={card}>
            <label style={{ display: 'block', marginBottom: 6 }}>
              <input type="checkbox" checked={settings.mirror} onChange={(e) => setSettings({ mirror: e.target.checked })} /> Mirror trades I make in Phantom into the bot (read-only)
            </label>
            <label style={{ display: 'block', color: settings.live ? '#f44336' : undefined }}>
              <input type="checkbox" checked={settings.live} onChange={(e) => toggleLive(e.target.checked)} /> Send bot trades to Phantom as proposals (REAL MONEY, you approve each one)
            </label>
            {settings.live && (
              <div style={{ marginTop: 8, fontSize: 13, color: '#bbb' }}>
                Max per trade $<input type="number" min="1" value={settings.capUsd} onChange={(e) => setSettings({ capUsd: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 70 }} />
                {' '}Slippage <input type="number" min="10" max="2000" value={settings.slippageBps} onChange={(e) => setSettings({ slippageBps: Math.min(2000, Math.max(10, Number(e.target.value) || 300)) })} style={{ width: 70 }} /> bps
                <div style={{ color: '#888', marginTop: 4 }}>Starts OFF every time you open the app. Only trades the bot makes AFTER you turn this on create proposals.</div>
              </div>
            )}
          </div>

          {proposals.length > 0 && (
            <div style={{ ...card, borderColor: '#f44336' }}>
              <b>Proposed trades (real money)</b>
              {proposals.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid #2e303a', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 200 }}>
                    <b style={{ color: p.side === 'buy' ? '#4caf50' : '#f44336' }}>{p.side.toUpperCase()}</b> {p.symbol || p.mint.slice(0, 6)}{' '}
                    {p.side === 'buy' ? `~${usd(p.usd)}` : `${Number(p.tokens).toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens`}
                    <div style={{ color: '#888', fontSize: 12 }}>{p.reason}{p.note ? ` · ${p.note}` : ''}</div>
                  </span>
                  {p.status === 'pending' && <button onClick={() => approve(p.id)} style={{ background: '#4caf50', color: '#fff', borderColor: '#4caf50' }}>Approve in Phantom</button>}
                  {p.status === 'working' && <span style={{ color: '#c084fc' }}>working...</span>}
                  {p.status === 'done' && <span style={{ color: '#4caf50' }}>done{p.sig ? <> · <a href={`https://solscan.io/tx/${p.sig}`} target="_blank" rel="noreferrer">tx</a></> : null}</span>}
                  {p.status === 'failed' && <span style={{ color: '#f44336' }}>failed</span>}
                  {p.status !== 'working' && <button onClick={() => dismiss(p.id)}>{p.status === 'pending' ? 'Skip' : 'Clear'}</button>}
                </div>
              ))}
            </div>
          )}

          <div style={card}>
            <b>Phantom holdings</b>
            {!wallet && <div style={{ color: '#888' }}>Loading...</div>}
            {wallet && wallet.holdings.length === 0 && <div style={{ color: '#888' }}>No tokens in this wallet.</div>}
            <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 6 }}>
              {wallet?.holdings.map((h) => {
                const c = ledger.cost[h.mint];
                const tracked = c && c.tokens > 0 && h.priceUsd;
                const pnl = tracked ? h.priceUsd * Math.min(h.amount, c.tokens) - c.costUsd * (Math.min(h.amount, c.tokens) / c.tokens) : null;
                return (
                  <div key={h.mint} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #2e303a' }}>
                    <CoinIcon src={h.iconUrl} symbol={h.symbol || '?'} size={26} />
                    <span style={{ flex: 1 }}><b>{h.symbol || h.mint.slice(0, 6)}</b><div style={{ color: '#888', fontSize: 12 }}>{h.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{h.marketCap ? ` · mc ${usd(h.marketCap)}` : ''}</div></span>
                    <span style={{ textAlign: 'right' }}>{usd(h.valueUsd)}{pnl != null && <div style={{ fontSize: 12, color: pnl >= 0 ? '#4caf50' : '#f44336' }}>{pnl >= 0 ? '+' : '-'}{usd(pnl)} since tracked</div>}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={card}>
            <b>Trades detected in Phantom</b>
            {ledger.trades.length === 0 && <div style={{ color: '#888' }}>None yet. Buys and sells you make in Phantom appear here within ~20 seconds.</div>}
            <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
              {ledger.trades.slice().reverse().map((t) => (
                <div key={t.sig} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: '1px solid #2e303a', fontSize: 13 }}>
                  <span><b style={{ color: t.side === 'buy' ? '#4caf50' : '#f44336' }}>{t.side.toUpperCase()}</b> {t.symbol || t.mint.slice(0, 6)} <span style={{ color: '#888' }}>{ago(t.time)}</span></span>
                  <span>{usd(t.usd)} <a href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noreferrer" style={{ color: '#888' }}>tx</a></span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
