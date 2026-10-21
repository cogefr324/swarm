// Free, keyless public API - https://api.rugcheck.xyz
// Used to check things DexScreener doesn't expose: holder concentration, insider/bundled
// wallet networks, dev holding %, and whether mint/freeze authority is still active.

const rcCache = new Map(); // mint -> { at, data }
export async function fetchRugCheckSummary(mint, maxAgeMs = 120000) {
  const hit = rcCache.get(mint);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const [rug, jup] = await Promise.all([fetchRugCheckSummaryUncached(mint), fetchJupiterAudit(mint)]);
  let data = rug;
  if (jup) {
    // Jupiter's audit numbers (dev balance, top holders, holder count) are the primary source when present
    data = { ...(rug || {}), jupiter: true };
    if (jup.devPct != null) data.devPct = jup.devPct;
    if (jup.top10Pct != null) data.top10Pct = jup.top10Pct;
    if (jup.holders != null) data.totalHolders = jup.holders;
    if (rug) {
      data.insiderWalletPct = data.totalHolders > 0 && rug.insiderWallets ? Math.min(100, (rug.insiderWallets / data.totalHolders) * 100) : rug.insiderWalletPct;
    } else {
      Object.assign(data, { riskScore: null, risks: [], rugged: false, insiderCount: 0, insiderWallets: 0, insiderHoldingPct: 0, largestNetwork: 0, lpLockedPct: null });
    }
    if (jup.mintDisabled != null) data.mintAuthorityActive = !jup.mintDisabled;
    if (jup.freezeDisabled != null) data.freezeAuthorityActive = !jup.freezeDisabled;
  }
  if (data) rcCache.set(mint, { at: Date.now(), data });
  return data || hit?.data || null; // keep showing the last good numbers if a refresh fails
}

// Jupiter token audit (free, keyless): dev balance %, top-holders %, holder count, authorities.
async function fetchJupiterAudit(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const list = await r.json();
    const t = Array.isArray(list) ? list.find((x) => x.id === mint) : null;
    if (!t) return null;
    const a = t.audit || {};
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
      devPct: num(a.devBalancePercentage),
      top10Pct: num(a.topHoldersPercentage),
      holders: num(t.holderCount),
      mintDisabled: typeof a.mintAuthorityDisabled === 'boolean' ? a.mintAuthorityDisabled : null,
      freezeDisabled: typeof a.freezeAuthorityDisabled === 'boolean' ? a.freezeAuthorityDisabled : null,
    };
  } catch { return null; }
}

async function fetchRugCheckSummaryUncached(mint) {
  try {
    const [summaryRes, reportRes] = await Promise.all([
      fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`),
      fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`),
    ]);

    const summary = summaryRes.ok ? await summaryRes.json() : null;
    const report = reportRes.ok ? await reportRes.json() : null;
    if (!summary && !report) return null;

    const risks = (summary?.risks || report?.risks || []).map((r) => ({
      name: r.name || 'Unknown risk',
      level: r.level || 'warn',
      description: r.description || '',
    }));

    const rugged = !!(report?.rugged ?? summary?.rugged);
    const riskScore = summary?.score_normalised ?? summary?.score ?? report?.score ?? null;

    // Holder concentration - defensive since exact field names can vary
    const topHolders = report?.topHolders || [];
    const top10Pct = topHolders.length
      ? topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0)
      : null;

    const creator = report?.creator || null;
    const devPct = creator && topHolders.length
      ? topHolders.filter((h) => h.address === creator).reduce((sum, h) => sum + (h.pct || 0), 0)
      : null;

    // bundles / insider detection. RugCheck's graphInsidersDetected is a count of WALLETS (not networks);
    // insiderNetworks is the list of linked-wallet groups.
    const networks = Array.isArray(report?.insiderNetworks) ? report.insiderNetworks : [];
    const insiderWallets = Number(report?.graphInsidersDetected) || networks.reduce((s, n) => s + (Number(n.size) || 0), 0);
    const insiderNetworkCount = networks.length;
    const largestNetwork = networks.reduce((m, n) => Math.max(m, Number(n.size) || 0), 0);
    const totalHolders = report?.totalHolders ?? null;
    const insiderWalletPct = totalHolders > 0 ? Math.min(100, (insiderWallets / totalHolders) * 100) : null;
    // supply share: prefer the networks' token amounts, fall back to flagged wallets among the top holders
    const supplyRaw = Number(report?.token?.supply) || 0;
    const netAmount = networks.reduce((s, n) => s + (Number(n.tokenAmount) || 0), 0);
    const netShare = supplyRaw > 0 && netAmount > 0 && netAmount <= supplyRaw ? (netAmount / supplyRaw) * 100 : null;
    const topInsiderPct = topHolders.filter((h) => h.insider).reduce((s, h) => s + (h.pct || 0), 0);
    const insiderHoldingPct = Math.max(netShare ?? 0, topInsiderPct);
    const insiderCount = insiderNetworkCount;
    const lpLockedPct = Array.isArray(report?.markets)
      ? report.markets.reduce((m, mk) => Math.max(m, Number(mk?.lp?.lpLockedPct) || 0), 0)
      : null;

    const mintAuthorityActive = !!report?.token?.mintAuthority;
    const freezeAuthorityActive = !!report?.token?.freezeAuthority;

    return {
      riskScore,
      risks,
      rugged,
      top10Pct,
      devPct,
      insiderCount,
      insiderWallets,
      insiderWalletPct,
      lpLockedPct,
      largestNetwork,
      insiderHoldingPct,
      totalHolders,
      mintAuthorityActive,
      freezeAuthorityActive,
    };
  } catch (e) {
    // network hiccup, CORS issue, or unrecognized token - fail soft, don't block farming on this alone
    return null;
  }
}
