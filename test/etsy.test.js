const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-test-'));
process.env.ETSY_API_KEY = 'key123';
process.env.ETSY_SHARED_SECRET = 'secret';
process.env.ETSY_REDIRECT_URI = 'http://localhost/auth/etsy/callback';
process.env.GEMINI_API_KEY_1 = 'gem-key';
process.env.GEMINI_MODELS = 'test-model';
process.env.TRANSLATE_DELAY_MS = '150';
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
const aiCalls = []; // { start, end } of each fake Gemini request
const etsyTranslations = new Map(); // "listing:lang" -> form fields

// Fake Etsy: 250 active listings (3 pages), 2 drafts, nothing else.
const calls = [];
const realFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  calls.push({ url, init });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.hostname === 'generativelanguage.googleapis.com') {
    const call = { start: Date.now() };
    aiCalls.push(call);
    await new Promise((r) => setTimeout(r, 30));
    call.end = Date.now();
    assert.equal(url.pathname, '/v1beta/models/test-model:generateContent');
    assert.equal(init.headers['x-goog-api-key'], 'gem-key');
    const req = JSON.parse(init.body);
    assert.equal(req.generationConfig.responseMimeType, 'application/json');
    const langs = req.generationConfig.responseSchema.required;
    const prompt = req.contents[0].parts[0].text;
    if (prompt.includes('FAILME')) {
      // Unparseable output: this listing fails, the others continue.
      return json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
    }
    assert.match(prompt, /Tom's mug & cup/); // HTML entities decoded before translating
    const out = Object.fromEntries(langs.map((l) => [l, {
      title: `<${l}> ai title`,
      description: `<${l}> ai description`,
      tags: ['good tag', 'way too long tag for etsy rules', 'bad!chars', 'good tag', ...Array.from({ length: 15 }, (_, i) => `t${i}`)],
    }]));
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  if (url.pathname === '/v3/public/oauth/token') {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.ok(body.get('code_verifier'));
    return json({ access_token: '42.tok', refresh_token: '42.ref', expires_in: 3600 });
  }
  assert.equal(init.headers['x-api-key'], 'key123:secret');
  assert.equal(init.headers.Authorization, 'Bearer 42.tok');
  const tr = url.pathname.match(/^\/v3\/application\/shops\/7\/listings\/(\d+)\/translations\/(\w+)$/);
  if (tr) {
    const key = `${tr[1]}:${tr[2]}`;
    if (init.method === 'PUT' && !etsyTranslations.has(key)) return json({ error: 'Translation not found' }, 404);
    if (init.method === 'POST' && etsyTranslations.has(key)) return json({ error: 'exists' }, 409);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    etsyTranslations.set(key, Object.fromEntries(new URLSearchParams(init.body)));
    return json({ listing_id: Number(tr[1]), language: tr[2] });
  }
  if (url.pathname === '/v3/application/users/me') return json({ user_id: 42, shop_id: 7 });
  if (url.pathname === '/v3/application/shops/7') return json({ shop_id: 7, shop_name: 'TestShop', url: 'https://etsy.com/shop/TestShop', currency_code: 'USD' });
  if (url.pathname === '/v3/application/shops/7/listings') {
    const state = url.searchParams.get('state');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const total = state === 'active' ? 250 : state === 'draft' ? 2 : 0;
    const results = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      results.push({ listing_id: (state === 'draft' ? 10000 : 0) + i, language: 'en-US', title: i === 1 ? 'FAILME' : `Tom&#39;s mug &amp; cup ${state} ${i}`, description: 'Great mug &amp; cup', state, quantity: 1, price: { amount: 1999, divisor: 100, currency_code: 'USD' }, skus: [`SKU${i}`], tags: [] });
    }
    return json({ count: total, results });
  }
  return json({ error: 'not found' }, 404);
};

const { app } = require('../src/server');

test('connect flow imports every listing across states and pages', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const start = await realFetch(`${base}/auth/etsy`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const consent = new URL(start.headers.get('location'));
  assert.equal(consent.origin + consent.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
  assert.match(consent.searchParams.get('scope'), /listings_w/);

  const state = consent.searchParams.get('state');
  const cb = await realFetch(`${base}/auth/etsy/callback?code=the-code&state=${state}`, { redirect: 'manual' });
  assert.equal(cb.headers.get('location'), '/?connected=1');

  const status = await (await realFetch(`${base}/api/etsy/status`)).json();
  assert.equal(status.connected, true);
  assert.equal(status.shop.shop_name, 'TestShop');
  assert.equal(status.total, 252);
  assert.equal(status.counts.active, 250);

  const listingPages = calls.filter((c) => c.url.pathname.endsWith('/listings') && c.url.searchParams.get('state') === 'active');
  assert.equal(listingPages.length, 3);

  const drafts = await (await realFetch(`${base}/api/etsy/listings?state=draft`)).json();
  assert.equal(drafts.total, 2);
  assert.equal(drafts.listings[0].price, 19.99);

  const csv = await (await realFetch(`${base}/api/etsy/listings/export.csv`)).text();
  assert.equal(csv.trim().split('\n').length, 253);

  // Replayed/forged state is rejected.
  const replay = await realFetch(`${base}/auth/etsy/callback?code=the-code&state=${state}`, { redirect: 'manual' });
  assert.match(replay.headers.get('location'), /error=/);
});

const post = (base, path, body) => realFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const draft0Engine = (gen) => gen.results.find((d) => d.listing_id === 0).engine;

async function waitJob(base, jobId) {
  for (;;) {
    const job = await (await realFetch(`${base}/api/jobs/${jobId}`)).json();
    if (job.status === 'done') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('translate selected listings with Gemini, then publish to Etsy', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const status = await (await realFetch(`${base}/api/etsy/status`)).json();
  assert.equal(status.canWrite, true);
  assert.strictEqual(status.translateProblem, null);

  // Listing 1 makes Gemini return bad output; that must not stop the others. 'en' and unknown codes are ignored.
  let r = await post(base, '/api/etsy/translations/generate', { listingIds: [0, 1, 2], languages: ['de', 'sv', 'en', 'xx'] });
  const gen = await waitJob(base, (await r.json()).jobId);
  assert.equal(gen.results.length, 2);
  assert.equal(gen.errors.length, 1);
  assert.match(gen.errors[0].error, /Translation failed on every model: test-model · key 1: invalid JSON/);
  assert.equal(gen.stopped, null);
  assert.equal(draft0Engine(gen), 'test-model · key 1');
  const draft = gen.results.find((d) => d.listing_id === 0);
  assert.deepEqual(Object.keys(draft.translations).sort(), ['de', 'sv']);
  assert.equal(draft.translations.sv.title, '<sv> ai title');
  const tags = draft.translations.de.tags;
  assert.equal(tags.length, 13);
  assert.equal(tags[0], 'good tag');
  assert.ok(tags.every((tg) => tg.length <= 20 && !tg.includes('!')));
  assert.equal(etsyTranslations.size, 0, 'generating must not change Etsy');

  // One AI request at a time, each starting >= TRANSLATE_DELAY_MS after the previous ended.
  assert.equal(aiCalls.length, 3);
  for (let i = 1; i < aiCalls.length; i++) {
    assert.ok(aiCalls[i].start - aiCalls[i - 1].end >= 145, `gap ${aiCalls[i].start - aiCalls[i - 1].end}ms`);
  }

  // Publish: first time creates (PUT 404 -> POST), second time updates via PUT.
  const items = [{ listing_id: 0, language: 'de', ...draft.translations.de, title: 'Edited by user' }];
  for (let i = 0; i < 2; i++) {
    r = await post(base, '/api/etsy/translations/publish', { items });
    const pub = await waitJob(base, (await r.json()).jobId);
    assert.deepEqual(pub.errors, []);
  }
  const saved = etsyTranslations.get('0:de');
  assert.equal(saved.title, 'Edited by user');
  assert.equal(saved.tags.split(',').length, 13);

  const rows = await (await realFetch(`${base}/api/etsy/listings?q=active 0`)).json();
  assert.deepEqual(rows.listings.find((l) => l.listing_id === 0).translations, ['de']);

  // Filters: translation status, sort, and search.
  const list = async (qs) => (await (await realFetch(`${base}/api/etsy/listings?${qs}`)).json()).listings;
  assert.deepEqual((await list('translated=has:de')).map((l) => l.listing_id), [0]);
  assert.deepEqual((await list('translated=any')).map((l) => l.listing_id), [0]);
  assert.equal((await list('translated=none')).length, 251);
  assert.equal((await list('translated=missing:de')).length, 251);
  assert.equal((await list('translated=missing:sv')).length, 252);
  assert.equal((await list('state=draft&translated=missing:de')).length, 2);
  assert.equal((await list('translated=has:all')).length, 0);
  assert.equal((await list('translated=missing:any')).length, 252);
  assert.equal((await list('q=sku12')).length, 11); // SKU12 and SKU120-129
  const byTitle = (await list('sort=title')).map((l) => l.title);
  assert.equal(byTitle[0], 'FAILME');
  assert.match((await list("q=tom's mug"))[0].title, /^Tom&#39;s/); // search matches decoded entities

  // Unknown listings / languages are rejected.
  r = await post(base, '/api/etsy/translations/publish', { items: [{ listing_id: 999999, language: 'de', title: 'x', description: 'y', tags: [] }] });
  assert.equal(r.status, 400);
});
