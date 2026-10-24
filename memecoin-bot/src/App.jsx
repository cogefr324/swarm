import { useState } from 'react';
import ErrorBoundary from './ErrorBoundary';
import WalletContextProvider from './WalletContextProvider';
import { PaperTradingProvider, usePaperTrading } from './PaperTradingContext';
import { AuthProvider, useAuth } from './AuthContext';
import AuthScreen from './AuthScreen';
import AccountModal from './AccountModal';
import CoinSearch from './CoinSearch';
import CoinDetailPanel from './CoinDetailPanel';
import TrendingPanel from './TrendingPanel';
import WatchlistPanel from './WatchlistPanel';
import PositionsList from './PositionsList';
import Dashboard from './Dashboard';
import BotLog from './BotLog';
import PnlSummary from './PnlSummary';
import { resolveEntry } from './trendingFeed';
import SettingsPanel from './SettingsPanel';
import SwapPanel from './SwapPanel';
import { PhantomProvider } from './PhantomContext';
import PhantomPanel from './PhantomPanel';
import HamburgerMenu from './HamburgerMenu';
import GuideModal from './GuideModal';
import GemAlertPopup from './GemAlertPopup';

// v2: thin wrapper so the gem popup can reach context without changing App's own shape
function GemAlerts() {
  const { gemAlerts, dismissGemAlert, buyGemFromAlert, settings } = usePaperTrading();
  return (
    <GemAlertPopup
      alerts={gemAlerts}
      onDismiss={dismissGemAlert}
      onBuy={buyGemFromAlert}
      autoBuyEnabled={settings.gemAutoBuyEnabled}
    />
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

// Gatekeeper: shows a loading state while we check for an existing session, the sign up/log in
// screen if there isn't one, and only mounts the trading app (and its per-account PaperTradingProvider)
// once the person is authenticated - trading is unreachable without an account, as requested.
function AuthGate() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8296ad' }}>
        Loading...
      </div>
    );
  }

  if (!session) return <AuthScreen />;

  return (
    <PaperTradingProvider userId={session.user.id}>
      <TradingApp />
    </PaperTradingProvider>
  );
}

const TABS = [
  ['scanning', '🔎 Scanning'],
  ['wallets', '💼 Wallets'],
  ['phantom', '👻 Phantom'],
  ['settings', '⚙️ Settings'],
];

function TradingApp() {
  const [tab, setTab] = useState('scanning'); // scanning | wallets | settings
  const [mode, setMode] = useState('paper'); // 'paper' or 'live' (shown under Wallets)
  const [selectedCoin, setSelectedCoin] = useState(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // opening a coin from anywhere takes you to the Scanning tab, where the coin page lives
  function openCoin(coin) {
    setSelectedCoin(coin);
    setTab('scanning');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Clicking a position (open, waiting or closed) opens that coin's page: info, chart and your trades.
  function handleViewCoin(position) {
    const base = {
      mint: position.mint || position.coinSnapshot?.mint,
      pairAddress: position.pairAddress || '',
      symbol: position.symbol,
      name: position.name || position.symbol,
      priceUsd: position.currentPrice ?? position.exitPrice ?? 0,
      liquidityUsd: 0,
      volume24h: 0,
      priceChange24h: 0,
      marketCap: position.currentMarketCap ?? 0,
      marketCapIsFdv: position.currentMarketCapIsFdv,
      iconUrl: null,
      ...(position.coinSnapshot || {}),
    };
    if (!base.mint) return;
    openCoin(base);
    // fill in the live pair (chart, liquidity, 24h numbers) if the saved snapshot doesn't have it
    if (!base.pairAddress) resolveEntry(base).then((full) => setSelectedCoin((cur) => (cur && cur.mint === full.mint ? { ...cur, ...full } : cur))).catch(() => {});
  }

  function handleGoHome() {
    setSelectedCoin(null);
    setTab('scanning');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const tabButton = ([id, label]) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      style={{
        padding: '9px 18px',
        fontSize: 14,
        whiteSpace: 'nowrap',
        fontWeight: tab === id ? 'bold' : 'normal',
        background: tab === id ? '#2a3d55' : 'transparent',
        borderColor: tab === id ? '#5ec8ff' : '#223247',
        color: tab === id ? '#fff' : '#aaa',
        borderRadius: 10,
      }}
    >
      {label}
    </button>
  );

  return (
    <WalletContextProvider>
      <PhantomProvider>
      <ErrorBoundary>
        <GemAlerts />
      </ErrorBoundary>

      <div style={{ position: 'relative', textAlign: 'center', paddingTop: 30, paddingBottom: 60, paddingInline: 16 }}>
        {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
        {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 1300, margin: '0 auto 18px', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 32, letterSpacing: 1, background: 'linear-gradient(135deg,#9be3ff,#3aa8ff)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Swarm</h1>
          <HamburgerMenu onGoHome={handleGoHome} onOpenGuide={() => setGuideOpen(true)} onOpenAccount={() => setAccountOpen(true)} onOpenPositions={() => setTab('wallets')} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 22, rowGap: 8 }}>
          {TABS.map(tabButton)}
        </div>

        <div style={{ maxWidth: 1300, margin: '0 auto', textAlign: 'left' }}>
          {tab === 'scanning' && (
            <div style={{ minWidth: 0 }}>
              {!selectedCoin && (
                <p style={{ color: '#8296ad', textAlign: 'center' }}>
                  Search a coin or pick one from the lists, set a budget, click "Start Farming" - the bot analyzes it (including
                  RugCheck holder/bundle data), then scales into dips or spikes with partial tranches, and scales out with partial
                  sells on pumps. Early gems the bot spots on its own show up as popups - those buy in immediately and take profit in clips.
                </p>
              )}
              <CoinSearch onSelectCoin={setSelectedCoin} />
              {!selectedCoin && (
                <ErrorBoundary>
                  <TrendingPanel onSelectCoin={setSelectedCoin} />
                </ErrorBoundary>
              )}
              <ErrorBoundary key={selectedCoin?.mint}>
                <CoinDetailPanel coin={selectedCoin} onBack={selectedCoin ? handleGoHome : undefined} />
              </ErrorBoundary>
            </div>
          )}

          {tab === 'wallets' && (
            <div>
              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <button
                  onClick={() => setMode('paper')}
                  style={{ padding: '8px 16px', marginRight: 8, fontWeight: mode === 'paper' ? 'bold' : 'normal', background: mode === 'paper' ? '#3ddc97' : undefined, color: mode === 'paper' ? 'white' : undefined, borderColor: mode === 'paper' ? '#3ddc97' : undefined }}
                >
                  Paper Wallet (Fake Money)
                </button>
                <button
                  onClick={() => setMode('live')}
                  style={{ padding: '8px 16px', fontWeight: mode === 'live' ? 'bold' : 'normal', background: mode === 'live' ? '#ff5d6c' : undefined, color: mode === 'live' ? 'white' : undefined, borderColor: mode === 'live' ? '#ff5d6c' : undefined }}
                >
                  Live Wallet (Real Funds)
                </button>
              </div>
              {mode === 'paper' ? (
                <ErrorBoundary>
                  <PnlSummary onViewCoin={handleViewCoin} />
                  <WatchlistPanel onViewCoin={handleViewCoin} />
                  <PositionsList onViewCoin={handleViewCoin} />
                  <BotLog />
                  <Dashboard onViewCoin={handleViewCoin} />
                </ErrorBoundary>
              ) : (
                <>
                  <p style={{ color: '#ff5d6c', textAlign: 'center' }}>
                    Live mode uses real funds from your connected wallet. Phase 3 proof-of-concept swap below.
                  </p>
                  <SwapPanel />
                </>
              )}
            </div>
          )}

          {tab === 'phantom' && (
            <ErrorBoundary>
              <PhantomPanel />
            </ErrorBoundary>
          )}

          {tab === 'settings' && (
            <ErrorBoundary>
              <SettingsPanel />
            </ErrorBoundary>
          )}
        </div>
      </div>
      </PhantomProvider>
    </WalletContextProvider>
  );
}
