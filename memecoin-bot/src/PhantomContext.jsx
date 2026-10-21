// Phantom <-> bot bridge.
//  * Phantom -> bot (read only): every few seconds the server reads your wallet's balances and new swaps from a free RPC. Buys / sells
//    you make in Phantom show up here with cost basis and PnL.
//  * Bot -> Phantom (REAL MONEY, off by default): when the bot paper-buys or paper-sells and "Send bot trades to Phantom" is on, a
//    PROPOSAL is created. Nothing is sent until you click Approve and then confirm in the Phantom popup. The bot never holds your keys.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { api } from './api';
import { usePaperTrading } from './PaperTradingContext';

const Ctx = createContext(null);
const WSOL = 'So11111111111111111111111111111111111111112';
const QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP = 'https://lite-api.jup.ag/swap/v1/swap';
const SETTINGS_KEY = 'phantomBridgeSettings';
const DEFAULT_SETTINGS = { mirror: true, live: false, capUsd: 25, slippageBps: 300 };

const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const emptyLedger = () => ({ lastSig: null, trades: [], cost: {}, real: {} });

export function PhantomProvider({ children }) {
  const { publicKey, connected, signTransaction } = useWallet();
  const address = connected && publicKey ? publicKey.toString() : null;
  const { positions } = usePaperTrading();

  const [settings, setSettingsState] = useState(() => ({ ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}), live: false })); // live always starts OFF
  const [wallet, setWallet] = useState(null); // { sol, solUsd, holdings }
  const [ledger, setLedgerState] = useState(emptyLedger);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [proposals, setProposals] = useState([]);
  const ledgerRef = useRef(ledger);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const setLedger = (l) => { ledgerRef.current = l; setLedgerState(l); if (address) write(`phantomLedger:${address}`, l); };
  const setSettings = (patch) => setSettingsState((s) => { const n = { ...s, ...patch }; write(SETTINGS_KEY, { ...n, live: false }); return n; });

  // load this wallet's saved ledger when it connects
  useEffect(() => {
    if (!address) { setWallet(null); return; }
    const l = { ...emptyLedger(), ...read(`phantomLedger:${address}`, {}) };
    ledgerRef.current = l; setLedgerState(l);
  }, [address]);

  // ---- Phantom -> bot ----
  const refresh = async () => {
    if (!address) return;
    setSyncing(true);
    try {
      const h = await api.walletHoldings(address);
      setWallet(h);
      if (settingsRef.current.mirror) {
        const l = ledgerRef.current;
        const r = await api.walletSync(address, l.lastSig);
        const known = new Set(l.trades.map((t) => t.sig));
        const cost = JSON.parse(JSON.stringify(l.cost));
        const trades = [...l.trades];
        const solUsd = r.solUsd || h.solUsd || 0;
        for (const t of r.trades || []) {
          if (known.has(t.sig)) continue;
          const usd = t.usdStable || t.sol * solUsd;
          const c = cost[t.mint] || (cost[t.mint] = { tokens: 0, costUsd: 0, realizedUsd: 0 });
          if (t.side === 'buy') { c.tokens += t.tokens; c.costUsd += usd; }
          else {
            const avg = c.tokens > 0 ? c.costUsd / c.tokens : 0;
            const sold = Math.min(t.tokens, c.tokens);
            c.realizedUsd += usd - avg * sold; c.tokens -= sold; c.costUsd -= avg * sold;
            if (c.tokens <= 1e-9) { c.tokens = 0; c.costUsd = 0; }
          }
          const sym = h.holdings.find((x) => x.mint === t.mint)?.symbol || null;
          trades.push({ ...t, usd, symbol: sym });
        }
        setLedger({ ...l, lastSig: r.newest || l.lastSig, trades: trades.slice(-200), cost });
      }
      setError(null);
    } catch (e) { setError(e.message); } finally { setSyncing(false); }
  };
  useEffect(() => {
    if (!address) return undefined;
    refresh();
    const id = setInterval(refresh, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ---- bot -> Phantom: turn the bot's paper trades into proposals (only while "live" is on) ----
  const prev = useRef(null);
  useEffect(() => {
    if (!settings.live || !address) { prev.current = null; return; }
    const cur = new Map(positions.map((p) => [p.id, { mint: p.mint, symbol: p.symbol, tokens: p.tokensHeld, price: p.currentPrice }]));
    if (!prev.current) { prev.current = cur; return; } // baseline: positions that already exist never trigger anything
    const add = [];
    for (const [id, c] of cur) {
      const o = prev.current.get(id)?.tokens ?? 0;
      if (c.tokens > o * 1.0001 + 1e-12 && c.price > 0) {
        const usd = Math.min((c.tokens - o) * c.price, settings.capUsd);
        if (usd >= 1) add.push({ side: 'buy', mint: c.mint, symbol: c.symbol, usd, reason: 'bot bought' });
      }
    }
    for (const [id, o] of prev.current) {
      const c = cur.get(id)?.tokens ?? 0;
      if (c < o.tokens * 0.9999) {
        const frac = Math.min(1, (o.tokens - c) / o.tokens);
        const real = ledgerRef.current.real[o.mint] || 0; // only tokens the bot itself bought through an approved proposal
        if (real > 0) add.push({ side: 'sell', mint: o.mint, symbol: o.symbol, tokens: frac >= 0.999 ? real : real * frac, reason: frac >= 0.999 ? 'bot closed position' : 'bot sold part' });
      }
    }
    prev.current = cur;
    if (add.length) setProposals((ps) => [...add.map((a) => ({ ...a, id: `${a.side}-${a.mint}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: 'pending', createdAt: Date.now() })), ...ps].slice(0, 30));
  }, [positions, settings.live, settings.capUsd, address]);

  const patchProposal = (id, patch) => setProposals((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const dismiss = (id) => setProposals((ps) => ps.filter((p) => p.id !== id));

  async function approve(id) {
    const p = proposals.find((x) => x.id === id);
    if (!p || !address) return;
    if (!signTransaction) return patchProposal(id, { status: 'failed', note: 'This wallet cannot sign transactions here.' });
    patchProposal(id, { status: 'working', note: 'Checking...' });
    try {
      const w = walletRef.current;
      const solUsd = w?.solUsd;
      if (!solUsd) throw new Error('SOL price unavailable - try again in a moment');
      if (p.side === 'buy') {
        // never buy something the scam filter rejects
        const v = await api.verifyToken(p.mint, p.symbol).catch(() => null);
        if (v && v.decision === 'buy_blocked' && v.enforced) throw new Error(`blocked by the scam filter: ${(v.reasons || [])[0] || 'failed checks'}`);
        if (!v) throw new Error('scam filter unavailable - not buying');
      }
      const { decimals } = await api.walletDecimals(p.mint);
      const sol = p.side === 'buy' ? Math.min(p.usd, settingsRef.current.capUsd) / solUsd : null;
      if (p.side === 'buy' && (w?.sol ?? 0) < sol + 0.01) throw new Error(`not enough SOL (need ~${(sol + 0.01).toFixed(3)}, have ${(w?.sol ?? 0).toFixed(3)})`);
      const inputMint = p.side === 'buy' ? WSOL : p.mint;
      const outputMint = p.side === 'buy' ? p.mint : WSOL;
      const amount = p.side === 'buy' ? Math.round(sol * 1e9) : Math.floor(p.tokens * 10 ** decimals);
      if (!(amount > 0)) throw new Error('nothing to trade');
      patchProposal(id, { note: 'Getting a quote...' });
      const q = await (await fetch(`${QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${settingsRef.current.slippageBps}&restrictIntermediateTokens=true`)).json();
      if (!q || q.error || !q.outAmount) throw new Error(`no route: ${q?.error || 'quote failed'}`);
      const impact = Math.abs(Number(q.priceImpactPct) || 0); const impactPct = impact <= 1 ? impact * 100 : impact;
      if (impactPct > 5) throw new Error(`price impact ${impactPct.toFixed(1)}% is too high`);
      const sw = await (await fetch(SWAP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
      if (!sw?.swapTransaction) throw new Error(`could not build the swap: ${sw?.error || 'unknown'}`);
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(sw.swapTransaction), (c) => c.charCodeAt(0)));
      patchProposal(id, { note: 'Approve in the Phantom popup...' });
      const signed = await signTransaction(tx);
      let bin = ''; for (const b of signed.serialize()) bin += String.fromCharCode(b);
      const { signature } = await api.walletSend(btoa(bin));
      patchProposal(id, { note: 'Sent - confirming...', sig: signature });
      let ok = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await api.walletStatus(signature).catch(() => null);
        if (st?.err) throw new Error('the transaction failed on-chain');
        if (st?.confirmed) { ok = true; break; }
      }
      if (!ok) throw new Error('not confirmed after 60s - check Phantom / Solscan before retrying');
      const l = ledgerRef.current;
      const real = { ...l.real };
      if (p.side === 'buy') real[p.mint] = (real[p.mint] || 0) + Number(q.outAmount) / 10 ** decimals;
      else real[p.mint] = Math.max(0, (real[p.mint] || 0) - amount / 10 ** decimals);
      setLedger({ ...l, real });
      patchProposal(id, { status: 'done', note: 'Confirmed', sig: signature });
      refresh();
    } catch (e) {
      const msg = /reject|declin|denied|cancel/i.test(e?.message || '') ? 'You declined it in Phantom - nothing was sent.' : e.message;
      patchProposal(id, { status: 'failed', note: msg });
    }
  }

  const value = { address, connected, wallet, ledger, error, syncing, settings, setSettings, proposals, approve, dismiss, refresh };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePhantom() {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePhantom must be used inside PhantomProvider');
  return v;
}
