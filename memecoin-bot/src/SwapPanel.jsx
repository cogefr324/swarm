import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { VersionedTransaction } from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap';

export default function SwapPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [inputMint, setInputMint] = useState(SOL_MINT);
  const [outputMint, setOutputMint] = useState(USDC_MINT);
  const [amount, setAmount] = useState('0.01');
  const [quote, setQuote] = useState(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  async function getQuote() {
    setStatus('Fetching quote...');
    setQuote(null);
    try {
      const lamports = Math.round(parseFloat(amount) * 1e9);
      const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${lamports}&slippageBps=50`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setStatus(`Quote error: ${data.error}`);
        return;
      }
      setQuote(data);
      setStatus('Quote ready. Review below.');
    } catch (err) {
      setStatus(`Failed to fetch quote: ${err.message}`);
    }
  }

  async function executeSwap() {
    if (!quote || !publicKey) return;
    setLoading(true);
    setStatus('Building transaction...');
    try {
      const swapRes = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: publicKey.toString(),
          wrapAndUnwrapSol: true,
        }),
      });
      const swapData = await swapRes.json();
      if (swapData.error) {
        setStatus(`Swap build error: ${swapData.error}`);
        setLoading(false);
        return;
      }

      const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuf);

      setStatus('Waiting for wallet signature...');
      const signedTx = await signTransaction(transaction);

      setStatus('Sending transaction...');
      const rawTx = signedTx.serialize();
      const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 2 });

      setStatus(`Submitted! Confirming... txid: ${txid}`);
      const confirmation = await connection.confirmTransaction(txid, 'confirmed');

      if (confirmation.value.err) {
        setStatus(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      } else {
        setStatus(`Swap confirmed! txid: ${txid}`);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', padding: 24, border: '1px solid #333', borderRadius: 12, fontFamily: 'sans-serif' }}>
      <h2>Manual Swap (Phase 3 — proof of concept)</h2>
      <WalletMultiButton />

      <div style={{ marginTop: 20 }}>
        <label>
          Amount (in SOL):
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ marginLeft: 8, width: 100 }}
          />
        </label>

        <div style={{ marginTop: 12, fontSize: 13, color: '#8296ad' }}>
          Swapping: SOL → USDC (test pair for this proof of concept — the real bot will swap
          SOL against whatever coin you pick, not USDC)
        </div>

        <button onClick={getQuote} style={{ marginTop: 12, marginRight: 8 }}>
          Get Quote
        </button>

        {quote && (
          <div style={{ marginTop: 12, padding: 12, background: '#162233', borderRadius: 8, color: '#f3f4f6' }}>
            <div>You send: {amount} SOL</div>
            <div>You receive (est): {(quote.outAmount / 1e6).toFixed(4)} USDC</div>
            <div>Price impact: {quote.priceImpactPct}%</div>

            {connected ? (
              <button onClick={executeSwap} disabled={loading} style={{ marginTop: 10 }}>
                {loading ? 'Processing...' : 'Confirm Swap'}
              </button>
            ) : (
              <div style={{ marginTop: 10, color: '#ff5d6c', fontSize: 13 }}>
                Connect your wallet above to actually execute this trade. Viewing quotes doesn't require it.
              </div>
            )}
          </div>
        )}

        {status && <p style={{ marginTop: 16 }}>{status}</p>}
      </div>
    </div>
  );
}
