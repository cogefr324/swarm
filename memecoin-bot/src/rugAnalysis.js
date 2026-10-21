// Pure helpers (browser + server) that turn RugCheck data + market numbers into a plain verdict.
// RugCheck's own score is "higher = riskier" (0-100 normalised); we combine it with the things it
// misses - fake holder counts, tiny liquidity vs market cap, bundled/insider wallets.

const LEVEL_RANK = { low: 0, medium: 1, high: 2, rugged: 3 };

// summary: RugCheck /report/summary (cheap). Used by the server to hide rugs from Top.
export function summaryVerdict(summary) {
  if (!summary) return null;
  const score = Number(summary.score_normalised ?? NaN);
  const risks = Array.isArray(summary.risks) ? summary.risks : [];
  const danger = risks.filter((r) => r.level === 'danger');
  const rugged = !!summary.rugged || risks.some((r) => /rug/i.test(r.name || '') && r.level === 'danger');
  let level = 'low';
  if (Number.isFinite(score)) level = score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  if (danger.length) level = LEVEL_RANK[level] < 2 ? 'high' : level;
  if (rugged) level = 'rugged';
  // LP (liquidity pool) lock: only a pool with ~0% locked/burned counts as unlocked (anything above 0% is fine)
  const lp = summary.lpLockedPct == null ? NaN : Number(summary.lpLockedPct);
  const lpUnlocked = Number.isFinite(lp) ? lp < 1 : risks.some((r) => /lp.*unlock|unlocked.*lp|liquidity.*unlock/i.test(r.name || ''));
  return { level, score: Number.isFinite(score) ? score : null, dangerNames: danger.map((r) => r.name), lpLockedPct: Number.isFinite(lp) ? lp : null, lpUnlocked };
}

// Market-structure red flags that need no API: a $300M "market cap" that can't be sold into.
export function marketFlags({ marketCap, liquidityUsd, volume24h }) {
  const flags = [];
  if (marketCap >= 5e6 && liquidityUsd > 0 && liquidityUsd / marketCap < 0.006)
    flags.push(`Liquidity is only ${((liquidityUsd / marketCap) * 100).toFixed(2)}% of market cap - the price can't really be sold into`);
  if (marketCap >= 50e6 && volume24h > 0 && volume24h / marketCap < 0.001)
    flags.push(`24h volume is only ${((volume24h / marketCap) * 100).toFixed(2)}% of market cap - inflated / dead market cap`);
  return flags;
}

// Full analysis for the coin info box. The LEVEL comes from RugCheck's own score (so a 1/100 coin is
// never shown as high risk). Our extra checks only add notes, and can lift LOW to MEDIUM at most.
export function fullVerdict({ rc, marketCap, liquidityUsd, volume24h }) {
  const notes = [];
  if (!rc) {
    const flags = marketFlags({ marketCap, liquidityUsd, volume24h });
    return { level: flags.length ? 'medium' : 'unknown', reasons: flags };
  }
  let level = 'low';
  if (rc.riskScore != null) level = rc.riskScore >= 50 ? 'high' : rc.riskScore >= 25 ? 'medium' : 'low';
  if (rc.rugged) level = 'rugged';

  let extra = false;
  for (const f of marketFlags({ marketCap, liquidityUsd, volume24h })) { notes.push(f); extra = true; }
  for (const r of rc.risks || []) if (r.level === 'danger' || r.level === 'warn') notes.push(r.name);
  if (rc.insiderHoldingPct >= 20) { notes.push(`Insider wallets hold ${rc.insiderHoldingPct.toFixed(1)}% of supply`); extra = true; }
  if (rc.devPct > 10) { notes.push(`Dev holds ${rc.devPct.toFixed(1)}%`); extra = true; }
  if (rc.mintAuthorityActive) { notes.push('Mint authority still active'); extra = true; }
  if (rc.freezeAuthorityActive) { notes.push('Freeze authority still active'); extra = true; }
  if (extra && level === 'low') level = 'medium';

  const seen = new Set();
  return { level, reasons: notes.filter((r) => !seen.has(r) && seen.add(r)) };
}
