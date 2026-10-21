// Computing market cap from a cached/third-party "marketCap" or "fdv" field can be wrong for
// tokens that burn supply (like STONK) - fdv especially assumes the original max supply, ignoring
// any burns. The authoritative fix: ask the Solana chain directly for the mint's CURRENT supply
// (burned tokens are literally removed from this number on-chain) and multiply by live price ourselves.
//
// The lookup now goes through OUR server (/api/supply), which talks to the public Solana RPCs,
// rotates between them, caches results and backs off on rate limits. The browser only ever sees a
// clean 200 from our own server, so there are no more 429/403 errors in the console.
import { api } from './api';

const SUPPLY_CACHE_MS = 60000;
const FAIL_COOLDOWN_MS = 30000;
const cache = new Map(); // mint -> { supply, fetchedAt }
const failedAt = new Map(); // mint -> timestamp
const inFlight = new Map(); // mint -> Promise

export function getCachedSupply(mint) {
  const entry = cache.get(mint);
  return entry ? entry.supply : null;
}

// Fire-and-forget refresh: kicks off a fetch if the cache is stale, updates the cache when it
// resolves, but doesn't block the caller - the caller reads getCachedSupply() and uses whatever's
// there (or a third-party field) for this tick.
export function refreshSupplyIfStale(mint) {
  const entry = cache.get(mint);
  const isStale = !entry || Date.now() - entry.fetchedAt > SUPPLY_CACHE_MS;
  if (!isStale || inFlight.has(mint)) return;
  if (Date.now() - (failedAt.get(mint) || 0) < FAIL_COOLDOWN_MS) return;
  if (inFlight.size >= 3) return;

  const promise = api
    .supply(mint)
    .then((data) => {
      const supply = Number(data?.supply);
      if (supply > 0) {
        cache.set(mint, { supply, fetchedAt: Date.now() });
        failedAt.delete(mint);
      } else {
        failedAt.set(mint, Date.now());
      }
    })
    .catch(() => failedAt.set(mint, Date.now()))
    .finally(() => inFlight.delete(mint));

  inFlight.set(mint, promise);
}
