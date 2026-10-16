const path = require('node:path');
const { loadEnv, etsySetupProblem } = require('./env');

loadEnv();

const express = require('express');
const etsy = require('./etsy');
const store = require('./store');
const openai = require('./openaiTranslate');
const { cleanTitle, cleanTags, decodeEntities } = require('./listingText');
const { startJob, getJob } = require('./jobs');

const app = express();
app.use(express.json({ limit: '5mb' }));
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

function toRow(l, translations = {}) {
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
    language: l.language || null,
    translations: Object.keys(translations[l.listing_id] || {}),
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
    store.update({ tokens }); // keep translation history when reconnecting
    const me = await client.getMe();
    if (!me.shop_id) throw new Error('This Etsy account has no shop');
    const shop = await client.getShop(me.shop_id);
    store.update({
      userId: me.user_id,
      shop: {
        shop_id: shop.shop_id,
        shop_name: shop.shop_name,
        url: shop.url,
        currency: shop.currency_code,
        languages: shop.languages || [],
      },
      scopes: etsy.config().scopes.split(' '),
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
  const { shop, connectedAt, lastSyncAt, lastSyncError, counts, listings, scopes } = store.load();
  res.json({
    setupProblem: etsySetupProblem(),
    translateProblem: openai.openaiSetupProblem(),
    // Shops connected before write access was added must reconnect once.
    canWrite: Boolean(scopes?.includes('listings_w')),
    translationLanguages: etsy.TRANSLATION_LANGUAGES,
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

const SORTS = {
  updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
  title: (a, b) => decodeEntities(a.title).localeCompare(decodeEntities(b.title)),
  price_asc: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  price_desc: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
  views: (a, b) => (b.views || 0) - (a.views || 0),
  favorites: (a, b) => (b.num_favorers || 0) - (a.num_favorers || 0),
};

/**
 * Filters: state, q (title/SKU/tag text), translated
 * ("none" | "any" | "has:<lang>" | "missing:<lang>"), sort (key of SORTS).
 */
app.get('/api/etsy/listings', (req, res) => {
  const { state, q, translated, sort } = req.query;
  const data = store.load();
  let rows = (data.listings || []).map((l) => toRow(l, data.translations));
  if (state) rows = rows.filter((r) => r.state === state);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) =>
      [decodeEntities(r.title), r.sku, decodeEntities(r.tags)].some((f) => f?.toLowerCase().includes(needle)));
  }
  if (translated === 'none') rows = rows.filter((r) => r.translations.length === 0);
  else if (translated === 'any') rows = rows.filter((r) => r.translations.length > 0);
  else if (translated) {
    const [mode, lang] = String(translated).split(':');
    if (mode === 'has') rows = rows.filter((r) => r.translations.includes(lang));
    if (mode === 'missing') rows = rows.filter((r) => !r.translations.includes(lang));
  }
  if (SORTS[sort]) rows.sort(SORTS[sort]);
  res.json({ total: rows.length, listings: rows });
});

app.get('/api/etsy/listings/raw', (req, res) => {
  res.json(store.load().listings || []);
});

app.get('/api/etsy/listings/export.csv', (req, res) => {
  const rows = (store.load().listings || []).map((l) => toRow(l));
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

// ---- Listing translation (OpenAI -> Etsy) ----

const baseLang = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];

/** Step 1: ask OpenAI (ChatGPT) for translations of the selected listings. Nothing is changed on Etsy yet. */
app.post('/api/etsy/translations/generate', (req, res) => {
  const problem = openai.openaiSetupProblem();
  if (problem) return res.status(400).json({ error: problem });

  const { listingIds = [], languages = [] } = req.body || {};
  const langs = [...new Set(languages)].filter((c) => etsy.TRANSLATION_LANGUAGES[c]);
  if (!langs.length) return res.status(400).json({ error: 'Choose at least one language' });

  const wanted = new Set(listingIds.map(Number));
  const listings = (store.load().listings || []).filter((l) => wanted.has(l.listing_id));
  if (!listings.length) return res.status(400).json({ error: 'Select at least one listing' });

  const job = startJob('generate', listings, async (listing) => {
    const targets = langs
      .filter((c) => c !== baseLang(listing.language))
      .map((code) => ({ code, name: etsy.TRANSLATION_LANGUAGES[code] }));
    if (!targets.length) throw new Error('Listing is already in the selected language');
    return {
      listing_id: listing.listing_id,
      source: { title: decodeEntities(listing.title), language: listing.language },
      translations: await openai.translateListing(listing, targets),
    };
  });
  res.json({ jobId: job.id });
});

/** Step 2: save the reviewed translations to Etsy. */
app.post('/api/etsy/translations/publish', (req, res) => {
  const { shop } = store.load();
  if (!shop) return res.status(400).json({ error: 'Etsy shop is not connected' });

  const known = new Set((store.load().listings || []).map((l) => l.listing_id));
  const items = (req.body?.items || [])
    .map((i) => ({
      listing_id: Number(i.listing_id),
      language: String(i.language),
      title: cleanTitle(i.title),
      description: String(i.description || '').trim(),
      tags: cleanTags(i.tags),
    }))
    .filter((i) => known.has(i.listing_id) && etsy.TRANSLATION_LANGUAGES[i.language] && i.title && i.description);
  if (!items.length) return res.status(400).json({ error: 'Nothing to publish' });

  const job = startJob(
    'publish',
    items,
    async (item) => {
      try {
        await client.upsertTranslation(shop.shop_id, item.listing_id, item.language, item);
      } catch (err) {
        if (err.status === 403) {
          throw new Error('Etsy denied write access. Click "Reconnect shop" to grant permission to update listings.');
        }
        throw err;
      }
      const all = store.load().translations || {};
      all[item.listing_id] = {
        ...all[item.listing_id],
        [item.language]: { title: item.title, tags: item.tags, updatedAt: new Date().toISOString() },
      };
      store.update({ translations: all });
      return { listing_id: item.listing_id, language: item.language };
    },
    { concurrency: 2 }, // stay well inside Etsy's rate limit
  );
  res.json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (the app may have restarted)' });
  res.json(job);
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
