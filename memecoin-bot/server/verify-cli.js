// Try the verifier on any coin from the command line (no trades, nothing is bought):
//   node verify-cli.js <mint> [TICKER] [dry-run|enforce]
import 'dotenv/config';
import { verify } from './verifier.js';

const [mint, ticker, mode] = process.argv.slice(2);
if (!mint) { console.error('usage: node verify-cli.js <mint> [TICKER] [dry-run|enforce]'); process.exit(1); }
const r = await verify({ mint, ticker, mode });
console.log(JSON.stringify(r, null, 2));
console.log(`\n=> ${r.decision}${r.reasons.length ? '\n   - ' + r.reasons.join('\n   - ') : ''}`);
process.exit(0);
