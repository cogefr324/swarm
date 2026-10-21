import { useState, useEffect } from 'react';
import { usePaperTrading } from './PaperTradingContext';

export default function SettingsPanel() {
  const { settings, updateSettings, resetPaperAccount } = usePaperTrading();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setDraft((d) => ({ ...d, [name]: type === 'checkbox' ? checked : parseFloat(value) || 0 }));
    setSaved(false);
  }

  function handleSave() {
    updateSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  function handleReset() {
    if (
      window.confirm(
        'Are you sure you want to reset your paper account? This will wipe open positions, trade history, and reset your paper balance back to $10,000.'
      )
    ) {
      resetPaperAccount();
    }
  }

  const field = (label, name, hint) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>{label}</label>
      <input
        type="number"
        name={name}
        value={draft[name]}
        onChange={handleChange}
        style={{ width: '100%', padding: 6, borderRadius: 4 }}
      />
      {hint && <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{hint}</div>}
    </div>
  );

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: 16, border: '1px solid #2e303a', borderRadius: 8, background: '#17181f', textAlign: 'left' }}>
      <h3 style={{ marginTop: 0 }}>Trading bot settings</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0 28px' }}>
      <div>

      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>Scaling (tranche sizes)</h4>
      {field('Tranche Buy (% of available cash)', 'trancheBuyPct', 'How much of what\'s left to deploy per dip/spike buy - never all at once')}
      {field('Tranche Sell (% of tokens held)', 'trancheSellPct', 'How much of your holding to sell per pump - never the whole position')}

      </div>
      <div>
      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>Entry/Exit Triggers</h4>
      {field('Dip Buy Threshold (% pullback)', 'dipBuyThresholdPct', 'Buy a tranche when price pulls back this % from its recent high')}
      {field('Spike Threshold (% in 5m)', 'spikeThresholdPct', 'Buy a tranche if price jumps this % in 5 minutes with strong buy pressure')}
      {field('Spike Buy Dominance Ratio (buys : sells)', 'spikeBuyDominanceRatio')}
      {field('Pump Sell Threshold (% from low)', 'takeProfitPct', 'Sell a tranche when price rises this % from its recent low')}

      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>Hard Safety Net</h4>
      {field('Stop Loss (% from avg cost)', 'stopLossPct', 'Fully closes the position if it ever falls this far below your average cost - the only automatic full exit')}

      </div>
      <div>
      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>Coin Analysis Minimums</h4>
      {field('Min Liquidity ($)', 'minLiquidityUsd')}
      {field('Min 24h Volume ($)', 'minVolume24hUsd')}

      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>Bundle / Holder Risk (via RugCheck)</h4>
      {field('Max Dev Holding (%)', 'maxDevHoldingPct')}
      {field('Max Top 10 Holders (%)', 'maxTop10HoldingPct')}

      </div>
      <div>
      <h4 style={{ color: '#c084fc', marginBottom: 8, marginTop: 16 }}>🚀 Early Gem Detection (v2)</h4>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          id="gemAutoBuyEnabled"
          name="gemAutoBuyEnabled"
          checked={!!draft.gemAutoBuyEnabled}
          onChange={handleChange}
        />
        <label htmlFor="gemAutoBuyEnabled" style={{ fontSize: 13 }}>
          Auto-buy detected early gems
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
          Auto-buy Amount per Gem ($)
        </label>
        <input
          type="number"
          name="gemAutoBuyAmountUsd"
          value={draft.gemAutoBuyAmountUsd}
          onChange={handleChange}
          disabled={!draft.gemAutoBuyEnabled}
          style={{ width: '100%', padding: 6, borderRadius: 4 }}
        />
      </div>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" id="gemVerifyDryRun" name="gemVerifyDryRun" checked={!!draft.gemVerifyDryRun} onChange={handleChange} />
        <label htmlFor="gemVerifyDryRun" style={{ fontSize: 12 }}>
          Token-verification dry-run (log what the copycat/scam filter would block, but don't block)
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
          Gem stop loss (% below entry, 0 = off)
        </label>
        <input
          type="number"
          name="gemStopLossPct"
          value={draft.gemStopLossPct ?? 30}
          onChange={handleChange}
          style={{ width: '100%', padding: 6, borderRadius: 4 }}
        />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
          Max gem positions open at once
        </label>
        <input
          type="number"
          name="gemMaxOpen"
          value={draft.gemMaxOpen ?? 5}
          onChange={handleChange}
          disabled={!draft.gemAutoBuyEnabled}
          style={{ width: '100%', padding: 6, borderRadius: 4 }}
        />
      </div>
      <div style={{ fontSize: 10, color: '#666', marginBottom: 16 }}>
        Gems buy in immediately on detection (no dip-waiting) and take profit in clips from +50% up to
        +200%. When disabled, you still get the popup alert and can buy manually from it.
      </div>

      </div>
      </div>

      <button
        onClick={handleSave}
        style={{
          width: '100%',
          maxWidth: 320,
          padding: '10px',
          marginTop: 8,
          background: saved ? '#1b3a1f' : '#4caf50',
          color: 'white',
          fontWeight: 'bold',
          borderRadius: 6,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {saved ? 'Saved ✓' : 'Save Settings'}
      </button>

      <hr style={{ borderColor: '#2e303a', margin: '16px 0' }} />

      <button
        onClick={handleReset}
        style={{
          width: '100%',
          padding: '10px',
          background: '#3a1717',
          color: '#f44336',
          borderColor: '#f44336',
          fontWeight: 'bold',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        Reset Paper Account ($10,000)
      </button>
    </div>
  );
}
