// Talks to the small Node server in /server - no Supabase/Firebase, just your own backend.
// In production the site is served by the same server, so the API lives at the same address.
const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:4000');
const TOKEN_KEY = 'tradingBotAuthToken';

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(`Can't reach the server at ${API_URL} - is it running? (see server-setup.md)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  getToken,
  clearToken: () => setToken(null),

  async signup(email, password) {
    const data = await request('/api/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(data.token);
    return data.user;
  },

  async login(email, password) {
    const data = await request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(data.token);
    return data.user;
  },

  async me() {
    return request('/api/me');
  },

  async getState() {
    const data = await request('/api/state');
    return data.state;
  },

  async supply(mint) {
    return request(`/api/supply?mint=${encodeURIComponent(mint)}`);
  },

  // Icons hosted on IPFS are blocked by the public gateways when loaded straight from a webpage
  // (403, "NotSameOrigin"), so we load them through our own server instead.
  imageUrl(url) {
    const m = /\/ipfs\/([A-Za-z0-9]+(?:\/[\w.\-]+)*)/.exec(url || '');
    return m ? `${API_URL}/api/img?p=${encodeURIComponent(m[1])}` : url;
  },

  async verifyToken(mint, ticker, mode) {
    return request(`/api/verify?mint=${encodeURIComponent(mint)}&ticker=${encodeURIComponent(ticker || '')}&mode=${mode || ''}`);
  },

  async pinCoin(mint) {
    return request('/api/pin', { method: 'POST', body: JSON.stringify({ mint }) });
  },

  async launchpadOf(mint) {
    return request(`/api/launchpad?mint=${encodeURIComponent(mint)}`);
  },

  async setLaunchpad(mint, label) {
    return request('/api/launchpad', { method: 'POST', body: JSON.stringify({ mint, label }) });
  },

  async mintInfo(mint) {
    return request(`/api/mintinfo?mint=${encodeURIComponent(mint)}`);
  },

  walletSync(address, since) { return request(`/api/wallet/sync?address=${encodeURIComponent(address)}${since ? `&since=${encodeURIComponent(since)}` : ''}`); },
  walletHoldings(address) { return request(`/api/wallet/holdings?address=${encodeURIComponent(address)}`); },
  walletSend(tx) { return request('/api/wallet/send', { method: 'POST', body: JSON.stringify({ tx }) }); },
  walletStatus(sig) { return request(`/api/wallet/status?sig=${encodeURIComponent(sig)}`); },
  walletDecimals(mint) { return request(`/api/wallet/decimals?mint=${encodeURIComponent(mint)}`); },

  async feed() {
    return request('/api/feed');
  },

  async saveState(state) {
    return request('/api/state', { method: 'PUT', body: JSON.stringify({ state }) });
  },
};
