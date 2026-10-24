export default function GuideModal({ onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111a26',
          border: '1px solid #223247',
          borderRadius: 12,
          maxWidth: 560,
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          padding: 24,
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>How to Use Swarm</h2>
          <button onClick={onClose} style={{ padding: '4px 10px' }}>✕</button>
        </div>

        <ol style={{ paddingLeft: 20, lineHeight: 1.7, fontSize: 14 }}>
          <li><strong>Scanning tab</strong> - browse <em>Top</em> (biggest vetted coins, 10k+ holders), <em>Trending</em> (most active right now) and <em>New Pairs</em>. Scam filters hide rugs, mintable/freezable tokens, bundled supply, fake volume and 90%+ insider or top-10 concentration. Click a coin to open it, or search by ticker / contract address.</li>
          <li><strong>Set a budget</strong> - how much paper money Swarm may use on this coin.</li>
          <li><strong>Start Farming</strong> - Swarm analyzes the coin first (liquidity, volume, buy/sell pressure, holder and mint checks). If it fails you'll see why; "Buy Now" lets you override with an amount you choose.</li>
          <li><strong>Automatic entries</strong> - it watches for a dip or a momentum spike and buys a <em>tranche</em> (a slice of the budget, never all of it) on whichever comes first.</li>
          <li><strong>Automatic cycling</strong> - more dips = more tranche buys; pumps = partial sells that free cash back up. A stop-loss is the only automatic full exit.</li>
          <li><strong>Close anytime</strong> - "Close Position" sells what's left back to your balance.</li>
          <li><strong>Early gem alerts</strong> - popups on the right show brand-new runners. Buy manually, or enable auto-buy in Settings; it buys in full and takes profit in slices from +50% to +200%.</li>
          <li><strong>Wallet tab</strong> - paper wallet (fake money) with positions, PnL, watchlist and bot log, or live wallet (real funds).</li>
          <li><strong>Phantom tab</strong> - connect Phantom to mirror your wallet read-only. Bot-to-Phantom trades are off by default and always need your approval.</li>
          <li><strong>Settings</strong> - tranche sizes, dip/spike/pump thresholds, stop-loss %, quality minimums and early-gem auto-buy. Press Save after changing.</li>
        </ol>

        <div style={{ marginTop: 16, padding: 12, background: '#162233', borderRadius: 8, fontSize: 13, color: '#aaa' }}>
          This is currently a <strong>paper trading beta</strong> - it simulates trades against real
          live prices using fake money. No real funds are traded yet.
        </div>
      </div>
    </div>
  );
}
