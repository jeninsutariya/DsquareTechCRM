const path = require('node:path');
const { loadEnv, etsySetupProblem } = require('./env');

loadEnv();

const express = require('express');
const etsy = require('./etsy');
const store = require('./store');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES) || 0;

// Pending OAuth attempts: state -> { codeVerifier, createdAt }. Expire after 10 minutes.
const pendingAuth = new Map();
const AUTH_TTL_MS = 10 * 60 * 1000;

const client = etsy.createClient({
  getTokens: () => store.load().tokens,
  saveTokens: (tokens) => store.update({ tokens }),
});

let syncInProgress = null;

/** Pull every listing from the connected shop and cache it locally. */
function syncListings() {
  if (syncInProgress) return syncInProgress;
  syncInProgress = (async () => {
    const { shop } = store.load();
    if (!shop) throw new Error('Etsy shop is not connected');
    const { listings, counts } = await client.getAllListings(shop.shop_id);
    store.update({ listings, counts, lastSyncAt: new Date().toISOString(), lastSyncError: null });
    console.log(`[etsy] synced ${listings.length} listings`, counts);
    return { total: listings.length, counts };
  })()
    .catch((err) => {
      store.update({ lastSyncError: err.message });
      throw err;
    })
    .finally(() => {
      syncInProgress = null;
    });
  return syncInProgress;
}

function toRow(l) {
  const price = l.price ? l.price.amount / l.price.divisor : null;
  return {
    listing_id: l.listing_id,
    title: l.title,
    state: l.state,
    quantity: l.quantity,
    price,
    currency: l.price?.currency_code,
    sku: (l.skus || []).join('|'),
    views: l.views,
    num_favorers: l.num_favorers,
    url: l.url,
    image: l.images?.[0]?.url_170x135 || null,
    tags: (l.tags || []).join('|'),
    updated_at: l.updated_timestamp ? new Date(l.updated_timestamp * 1000).toISOString() : null,
  };
}

// ---- OAuth: one click to connect ----

app.get('/auth/etsy', (req, res) => {
  const problem = etsySetupProblem();
  if (problem) return res.redirect(`/?error=${encodeURIComponent(problem)}`);

  const now = Date.now();
  for (const [s, v] of pendingAuth) if (now - v.createdAt > AUTH_TTL_MS) pendingAuth.delete(s);

  const { url, state, codeVerifier } = etsy.createAuthRequest();
  pendingAuth.set(state, { codeVerifier, createdAt: now });
  res.redirect(url);
});

app.get('/auth/etsy/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(errorDescription || error)}`);

  const pending = pendingAuth.get(state);
  pendingAuth.delete(state);
  if (!code || !pending || Date.now() - pending.createdAt > AUTH_TTL_MS) {
    return res.redirect('/?error=' + encodeURIComponent('Connection expired or invalid, please try again'));
  }

  try {
    const tokens = await etsy.exchangeCode(code, pending.codeVerifier);
    store.save({ tokens });
    const me = await client.getMe();
    if (!me.shop_id) throw new Error('This Etsy account has no shop');
    const shop = await client.getShop(me.shop_id);
    store.update({
      userId: me.user_id,
      shop: { shop_id: shop.shop_id, shop_name: shop.shop_name, url: shop.url, currency: shop.currency_code },
      connectedAt: new Date().toISOString(),
    });
    // Connect -> immediately fetch all listings.
    await syncListings();
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('[etsy] connect failed:', err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/auth/etsy/disconnect', (req, res) => {
  store.clear();
  res.json({ ok: true });
});

// ---- API ----

app.get('/api/etsy/status', (req, res) => {
  const { shop, connectedAt, lastSyncAt, lastSyncError, counts, listings } = store.load();
  res.json({
    setupProblem: etsySetupProblem(),
    connected: Boolean(shop),
    shop: shop || null,
    connectedAt: connectedAt || null,
    lastSyncAt: lastSyncAt || null,
    lastSyncError: lastSyncError || null,
    syncing: Boolean(syncInProgress),
    counts: counts || {},
    total: listings?.length || 0,
  });
});

app.post('/api/etsy/listings/sync', async (req, res) => {
  try {
    res.json(await syncListings());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/etsy/listings', (req, res) => {
  const { state, q } = req.query;
  let rows = (store.load().listings || []).map(toRow);
  if (state) rows = rows.filter((r) => r.state === state);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => r.title?.toLowerCase().includes(needle) || r.sku.toLowerCase().includes(needle));
  }
  res.json({ total: rows.length, listings: rows });
});

app.get('/api/etsy/listings/raw', (req, res) => {
  res.json(store.load().listings || []);
});

app.get('/api/etsy/listings/export.csv', (req, res) => {
  const rows = (store.load().listings || []).map(toRow);
  const cols = ['listing_id', 'title', 'state', 'quantity', 'price', 'currency', 'sku', 'views', 'num_favorers', 'tags', 'url', 'updated_at'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="etsy-listings.csv"');
  res.send(csv);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DsquareTech CRM running at http://localhost:${PORT}`);
    const problem = etsySetupProblem();
    if (problem) console.warn(`[etsy] Setup needed: ${problem}`);
    if (SYNC_INTERVAL_MINUTES > 0) {
      setInterval(() => {
        if (store.load().shop) syncListings().catch((err) => console.error('[etsy] auto-sync failed:', err.message));
      }, SYNC_INTERVAL_MINUTES * 60 * 1000);
      console.log(`[etsy] auto-sync every ${SYNC_INTERVAL_MINUTES} min`);
    }
  });
}

module.exports = { app, syncListings, toRow };
