const path = require('node:path');
const { loadEnv, etsySetupProblem } = require('./env');

loadEnv();

const express = require('express');
const etsy = require('./etsy');
const store = require('./store');
const translator = require('./translator');
const { cleanTitle, cleanTags, decodeEntities, looksUntranslated } = require('./listingText');
const { startJob, getJob } = require('./jobs');

const app = express();
app.use(express.json({ limit: '100mb' }));
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
  store.drafts.clear();
  res.json({ ok: true });
});

// ---- API ----

app.get('/api/etsy/status', (req, res) => {
  const { shop, connectedAt, lastSyncAt, lastSyncError, counts, listings, scopes } = store.load();
  res.json({
    setupProblem: etsySetupProblem(),
    translateProblem: translator.setupProblem(),
    translatorChain: translator.chainStatus(),
    translatorKeys: translator.keyStatus(),
    drafts: countDrafts(),
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
 * ("none" | "any" | "has:<lang>" | "missing:<lang>" | "has:all" | "missing:any"), sort (key of SORTS).
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
    const all = Object.keys(etsy.TRANSLATION_LANGUAGES);
    const has = (r, l) => r.translations.includes(l);
    if (mode === 'has' && lang === 'all') rows = rows.filter((r) => all.every((l) => has(r, l)));
    else if (mode === 'missing' && lang === 'any') rows = rows.filter((r) => !all.every((l) => has(r, l)));
    else if (mode === 'has') rows = rows.filter((r) => has(r, lang));
    else if (mode === 'missing') rows = rows.filter((r) => !has(r, lang));
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

// ---- Listing translation (Gemini model/key chain -> Etsy) ----

/** Listings translated at the same time: TRANSLATE_CONCURRENCY, default one per API key (at least 5). */
const translateConcurrency = () => Number(process.env.TRANSLATE_CONCURRENCY) || Math.max(5, translator.keyCount());

const baseLang = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];
const listingMap = () => new Map((store.load().listings || []).map((l) => [l.listing_id, l]));

/** Normalize one draft and flag a description that is still in the source language. */
function makeDraft(listing, fields, extra = {}) {
  const description = String(fields.description || '').trim();
  return {
    title: cleanTitle(fields.title),
    description,
    tags: cleanTags(fields.tags),
    include: fields.include !== false,
    untranslated: looksUntranslated(listing?.description || '', description),
    ...extra,
  };
}

/**
 * Step 1: generate translations with the model/key chain (see translator.js) and save
 * each listing's result as a draft right away, so nothing has to be generated twice.
 * Languages that already have a good draft or a published translation are skipped
 * unless `retranslate` is set. Nothing is changed on Etsy.
 */
app.post('/api/etsy/translations/generate', (req, res) => {
  const problem = translator.setupProblem();
  if (problem) return res.status(400).json({ error: problem });

  const { listingIds = [], languages = [], retranslate = false } = req.body || {};
  const langs = [...new Set(languages)].filter((c) => etsy.TRANSLATION_LANGUAGES[c]);
  if (!langs.length) return res.status(400).json({ error: 'Choose at least one language' });

  const wanted = new Set(listingIds.map(Number));
  const listings = (store.load().listings || []).filter((l) => wanted.has(l.listing_id));
  if (!listings.length) return res.status(400).json({ error: 'Select at least one listing' });

  const job = startJob('generate', listings, async (listing, job, worker) => {
    const id = listing.listing_id;
    const own = langs.filter((c) => c !== baseLang(listing.language));
    if (!own.length) throw new Error('Listing is already in the selected language');
    const drafted = store.drafts.load()[id] || {};
    const published = store.load().translations?.[id] || {};
    const todo = retranslate ? own : own.filter((c) => !(drafted[c] && !drafted[c].untranslated) && !published[c]);
    if (!todo.length) return { listing_id: id, engine: 'already done', languages: [] };

    const targets = todo.map((code) => ({ code, name: etsy.TRANSLATION_LANGUAGES[code] }));
    const { translations, engine } = await translator.translateListing(listing, targets, {
      worker,
      onAttempt: (label) => (job.current = label),
    });
    const keyName = engine.split(' · ')[1];
    job.perKey = { ...job.perKey, [keyName]: (job.perKey?.[keyName] || 0) + 1 };
    const all = store.drafts.load();
    all[id] = { ...all[id] };
    for (const [code, t] of Object.entries(translations)) {
      all[id][code] = makeDraft(listing, t, { engine, createdAt: new Date().toISOString() });
    }
    store.drafts.save(all);
    return { listing_id: id, engine, languages: Object.keys(translations) };
  }, { concurrency: translateConcurrency() }); // parallel across API keys (see translator.js)
  res.json({ jobId: job.id });
});

function countDrafts() {
  let publishable = 0;
  let untranslated = 0;
  for (const langs of Object.values(store.drafts.load())) {
    for (const d of Object.values(langs)) {
      if (d.untranslated) untranslated++;
      else if (d.include) publishable++;
    }
  }
  return { publishable, untranslated };
}

/** Saved drafts, in listing order, for the review screen. */
app.get('/api/etsy/drafts', (req, res) => {
  const drafts = store.drafts.load();
  const byId = listingMap();
  const listings = [];
  let publishable = 0;
  let untranslated = 0;
  for (const [id, langs] of Object.entries(drafts)) {
    const listing = byId.get(Number(id));
    if (!listing) continue;
    for (const d of Object.values(langs)) {
      if (d.untranslated) untranslated++;
      else if (d.include) publishable++;
    }
    listings.push({ listing_id: Number(id), title: decodeEntities(listing.title), langs });
  }
  const order = [...byId.keys()];
  listings.sort((a, b) => order.indexOf(a.listing_id) - order.indexOf(b.listing_id));
  res.json({ publishable, untranslated, listings });
});

/** Save an edit (or include/skip toggle) to one draft. */
app.put('/api/etsy/drafts/:id/:lang', (req, res) => {
  const id = Number(req.params.id);
  const all = store.drafts.load();
  const current = all[id]?.[req.params.lang];
  if (!current) return res.status(404).json({ error: 'Draft not found' });
  all[id][req.params.lang] = makeDraft(listingMap().get(id), { ...current, ...req.body }, {
    engine: current.engine,
    createdAt: current.createdAt,
    edited: true,
  });
  store.drafts.save(all);
  res.json(all[id][req.params.lang]);
});

app.delete('/api/etsy/drafts', (req, res) => {
  store.drafts.clear();
  res.json({ ok: true });
});

/**
 * Step 2: publish saved drafts to Etsy one at a time. Each draft is removed once Etsy
 * has it, so a stopped or failed run can simply be started again. Drafts whose
 * description is still in the source language are never published.
 */
function startPublish(filter = () => true) {
  const { shop } = store.load();
  if (!shop) return { error: 'Etsy shop is not connected' };
  const byId = listingMap();
  const items = [];
  let skippedUntranslated = 0;
  for (const [id, langs] of Object.entries(store.drafts.load())) {
    for (const [language, d] of Object.entries(langs)) {
      const item = { listing_id: Number(id), language };
      if (!byId.has(item.listing_id) || !d.include || !filter(item)) continue;
      if (d.untranslated) {
        skippedUntranslated++;
        continue;
      }
      items.push(item);
    }
  }
  if (!items.length) return { error: skippedUntranslated ? 'Every draft still has an untranslated description' : 'Nothing to publish' };

  const job = startJob('publish', items, async (item) => {
    const draft = store.drafts.load()[item.listing_id]?.[item.language];
    if (!draft) return { ...item, skipped: true }; // removed meanwhile
    const exists = Boolean(store.load().translations?.[item.listing_id]?.[item.language]);
    try {
      await client.upsertTranslation(shop.shop_id, item.listing_id, item.language, draft, { exists });
    } catch (err) {
      if (err.status === 403) {
        throw Object.assign(new Error('Etsy denied write access. Click "Reconnect shop", then publish again; your drafts are saved.'), { stopJob: true });
      }
      if (err.status === 429) {
        throw Object.assign(new Error('Etsy API limit reached. Publish again later; the remaining drafts are saved.'), { stopJob: true });
      }
      throw err;
    }
    const published = store.load().translations || {};
    published[item.listing_id] = {
      ...published[item.listing_id],
      [item.language]: { title: draft.title, tags: draft.tags, updatedAt: new Date().toISOString() },
    };
    store.update({ translations: published });
    const all = store.drafts.load();
    if (all[item.listing_id]) {
      delete all[item.listing_id][item.language];
      if (!Object.keys(all[item.listing_id]).length) delete all[item.listing_id];
      store.drafts.save(all);
    }
    return item;
  }, { concurrency: Number(process.env.PUBLISH_CONCURRENCY) || 3 }); // Etsy allows ~10 requests/second
  return { jobId: job.id, skippedUntranslated };
}

app.post('/api/etsy/drafts/publish', (req, res) => {
  const ids = req.body?.listingIds ? new Set(req.body.listingIds.map(Number)) : null;
  const result = startPublish((i) => !ids || ids.has(i.listing_id));
  res.status(result.error ? 400 : 200).json(result);
});

/** Older pages send the reviewed translations themselves: save them as drafts, then publish those. */
app.post('/api/etsy/translations/publish', (req, res) => {
  const byId = listingMap();
  const all = store.drafts.load();
  const keys = new Set();
  for (const i of req.body?.items || []) {
    const id = Number(i.listing_id);
    if (!byId.has(id) || !etsy.TRANSLATION_LANGUAGES[i.language]) continue;
    all[id] = { ...all[id], [i.language]: makeDraft(byId.get(id), i, { createdAt: new Date().toISOString() }) };
    keys.add(`${id}:${i.language}`);
  }
  store.drafts.save(all);
  const result = startPublish((i) => keys.has(`${i.listing_id}:${i.language}`));
  res.status(result.error ? 400 : 200).json(result);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (the app may have restarted)' });
  res.json(job.type === 'generate' ? { ...job, keys: translator.keyStatus() } : job);
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
