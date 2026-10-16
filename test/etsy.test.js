const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-test-'));
process.env.ETSY_API_KEY = 'key123';
process.env.ETSY_SHARED_SECRET = 'secret';
process.env.ETSY_REDIRECT_URI = 'http://localhost/auth/etsy/callback';

// Fake Etsy: 250 active listings (3 pages), 2 drafts, nothing else.
const calls = [];
const realFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  calls.push({ url, init });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.pathname === '/v3/public/oauth/token') {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.ok(body.get('code_verifier'));
    return json({ access_token: '42.tok', refresh_token: '42.ref', expires_in: 3600 });
  }
  assert.equal(init.headers['x-api-key'], 'key123:secret');
  assert.equal(init.headers.Authorization, 'Bearer 42.tok');
  if (url.pathname === '/v3/application/users/me') return json({ user_id: 42, shop_id: 7 });
  if (url.pathname === '/v3/application/shops/7') return json({ shop_id: 7, shop_name: 'TestShop', url: 'https://etsy.com/shop/TestShop', currency_code: 'USD' });
  if (url.pathname === '/v3/application/shops/7/listings') {
    const state = url.searchParams.get('state');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const total = state === 'active' ? 250 : state === 'draft' ? 2 : 0;
    const results = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      results.push({ listing_id: (state === 'draft' ? 10000 : 0) + i, title: `${state} ${i}`, state, quantity: 1, price: { amount: 1999, divisor: 100, currency_code: 'USD' }, skus: [`SKU${i}`], tags: [] });
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
