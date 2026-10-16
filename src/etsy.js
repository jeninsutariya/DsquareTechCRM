const crypto = require('node:crypto');

const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const API_BASE = 'https://openapi.etsy.com/v3/application';

const LISTING_STATES = ['active', 'inactive', 'sold_out', 'draft', 'expired'];
const PAGE_LIMIT = 100; // Etsy's maximum page size

function config() {
  const apiKey = process.env.ETSY_API_KEY;
  const redirectUri = process.env.ETSY_REDIRECT_URI;
  if (!apiKey || !redirectUri) {
    throw new Error('ETSY_API_KEY and ETSY_REDIRECT_URI must be set (see .env.example)');
  }
  return {
    apiKey,
    sharedSecret: process.env.ETSY_SHARED_SECRET || '',
    redirectUri,
    scopes: process.env.ETSY_SCOPES || 'listings_r shops_r profile_r',
  };
}

// Etsy expects "keystring:shared_secret" in x-api-key; fall back to the bare keystring.
function apiKeyHeader() {
  const { apiKey, sharedSecret } = config();
  return sharedSecret ? `${apiKey}:${sharedSecret}` : apiKey;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build the Etsy consent URL plus the PKCE verifier/state the callback must check. */
function createAuthRequest() {
  const { apiKey, redirectUri, scopes } = config();
  const state = base64url(crypto.randomBytes(16));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: apiKey,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params}`, state, codeVerifier };
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Etsy token error ${res.status}: ${data.error_description || data.error || res.statusText}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Refresh a minute early to avoid using a token that expires mid-request.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

function exchangeCode(code, codeVerifier) {
  const { apiKey, redirectUri } = config();
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: apiKey,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
}

function refreshTokens(refreshToken) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: config().apiKey,
    refresh_token: refreshToken,
  });
}

/**
 * Authenticated API client. `getTokens`/`saveTokens` let the caller persist
 * refreshed tokens so the shop stays connected across restarts.
 */
function createClient({ getTokens, saveTokens }) {
  async function validAccessToken() {
    let tokens = getTokens();
    if (!tokens) throw new Error('Etsy shop is not connected');
    if (Date.now() >= tokens.expiresAt) {
      tokens = await refreshTokens(tokens.refreshToken);
      saveTokens(tokens);
    }
    return tokens.accessToken;
  }

  async function request(path, query = {}, attempt = 0) {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKeyHeader(),
        Authorization: `Bearer ${await validAccessToken()}`,
      },
    });

    // Back off on rate limits / transient server errors.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return request(path, query, attempt + 1);
    }
    // Token revoked or expired early: force one refresh and retry.
    if (res.status === 401 && attempt === 0) {
      const tokens = getTokens();
      if (tokens) saveTokens({ ...tokens, expiresAt: 0 });
      return request(path, query, attempt + 1);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Etsy API ${res.status} on ${path}: ${data.error || res.statusText}`);
    }
    return data;
  }

  const getMe = () => request('/users/me');
  const getShop = (shopId) => request(`/shops/${shopId}`);

  /** Fetch every listing in one state, following offset pagination. */
  async function getListingsByState(shopId, state) {
    const all = [];
    for (let offset = 0; ; offset += PAGE_LIMIT) {
      const page = await request(`/shops/${shopId}/listings`, {
        state,
        limit: PAGE_LIMIT,
        offset,
        includes: 'Images',
      });
      all.push(...page.results);
      if (page.results.length < PAGE_LIMIT || all.length >= page.count) break;
    }
    return all;
  }

  /** Fetch all listings across every state, de-duplicated by listing_id. */
  async function getAllListings(shopId, states = LISTING_STATES) {
    const byId = new Map();
    const counts = {};
    for (const state of states) {
      const listings = await getListingsByState(shopId, state);
      counts[state] = listings.length;
      for (const l of listings) byId.set(l.listing_id, l);
    }
    return { listings: [...byId.values()], counts };
  }

  return { request, getMe, getShop, getListingsByState, getAllListings };
}

module.exports = {
  LISTING_STATES,
  createAuthRequest,
  exchangeCode,
  refreshTokens,
  createClient,
};
