import ErrorBoundary from './ErrorBoundary';
import WatchlistPanel from './WatchlistPanel';
import PositionsList from './PositionsList';
import Dashboard from './Dashboard';

export default function PositionsModal({ onClose, onViewCoin }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 900, overflowY: 'auto', padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 1000, margin: '0 auto', background: '#101117', border: '1px solid #2e303a', borderRadius: 10, padding: 20, textAlign: 'left' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Wallet</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <ErrorBoundary>
          <WatchlistPanel onViewCoin={onViewCoin} />
          <PositionsList onViewCoin={onViewCoin} />
        </ErrorBoundary>
        <ErrorBoundary>
          <Dashboard />
        </ErrorBoundary>
      </div>
    </div>
  );
}
