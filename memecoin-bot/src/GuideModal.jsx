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
          background: '#17181f',
          border: '1px solid #2e303a',
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
          <h2 style={{ margin: 0, fontSize: 22 }}>How to Use the Bot</h2>
          <button onClick={onClose} style={{ padding: '4px 10px' }}>✕</button>
        </div>

        <ol style={{ paddingLeft: 20, lineHeight: 1.7, fontSize: 14 }}>
          <li>
            <strong>Search a coin</strong> - type a ticker (e.g. BONK) or paste a Solana contract
            address, then click a result.
          </li>
          <li>
            <strong>Set a budget</strong> - how much paper money to allocate to farming this coin.
          </li>
          <li>
            <strong>Start Farming</strong> - the bot analyzes the coin first (liquidity, volume,
            buy/sell pressure, and RugCheck holder/bundle/mint-authority checks). If it fails, you'll
            see exactly why - you can still override with "Buy Now" if you want.
          </li>
          <li>
            <strong>It waits for an entry</strong> - once analysis passes, the bot watches for either
            a dip or a momentum spike, and buys a <em>tranche</em> (a slice of your budget, never all
            of it) on whichever happens first.
          </li>
          <li>
            <strong>It keeps cycling</strong> - further dips trigger more tranche buys with what's
            left of the budget; pumps trigger tranche sells, freeing cash back up. This repeats
            automatically, scaling in on weakness and taking partial profit on strength.
          </li>
          <li>
            <strong>Stop-loss</strong> is the only automatic full exit - if price falls too far below
            your average cost, everything is sold and the cash returned to your balance.
          </li>
          <li>
            <strong>Close anytime</strong> - click "Close Position" to manually exit and return
            whatever's left to your balance.
          </li>
          <li>
            <strong>Early gem alerts</strong> (new) - the bot also scans for brand-new trending
            runners in the background. When it spots one, a popup appears on the right showing why.
            You can buy it manually in "clip mode", or let auto-buy do it for you if you've enabled
            that in Settings - either way it buys the full amount immediately (no waiting for a dip)
            and takes profit automatically in slices from +50% up to +200%.
          </li>
          <li>
            <strong>Settings</strong> (right sidebar) control tranche sizes, dip/spike/pump
            thresholds, the stop-loss %, the coin-quality minimums used during analysis, and the
            early-gem auto-buy toggle/amount - remember to hit "Save Settings" after changing them.
          </li>
        </ol>

        <div style={{ marginTop: 16, padding: 12, background: '#1f2028', borderRadius: 8, fontSize: 13, color: '#aaa' }}>
          This is currently a <strong>paper trading beta</strong> - it simulates trades against real
          live prices using fake money. No real funds are traded yet.
        </div>
      </div>
    </div>
  );
}
