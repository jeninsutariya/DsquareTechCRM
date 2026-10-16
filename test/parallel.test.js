const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-test-'));
process.env.ETSY_API_KEY = 'key123';
process.env.ETSY_REDIRECT_URI = 'http://localhost/auth/etsy/callback';
process.env.GEMINI_API_KEY_1 = 'k1';
process.env.GEMINI_API_KEY_2 = 'k2';
process.env.GEMINI_API_KEY_3 = 'k3';
process.env.GEMINI_MODELS = 'm';
process.env.TRANSLATE_DELAY_MS = '0';
delete process.env.TRANSLATE_CONCURRENCY;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

fs.writeFileSync(path.join(process.env.DATA_DIR, 'etsy.json'), JSON.stringify({
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3 },
  scopes: ['listings_r', 'listings_w'],
  shop: { shop_id: 7, shop_name: 'Test' },
  listings: Array.from({ length: 9 }, (_, i) => ({
    listing_id: i, language: 'en-US', title: `Listing ${i}`, description: `Description ${i}`, tags: ['tag'], state: 'active',
  })),
}));

const inFlight = new Map(); // key -> requests running now
let maxTotal = 0;
let maxPerKey = 0;
const perKey = new Map();
const realFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const key = init.headers['x-goog-api-key'];
  inFlight.set(key, (inFlight.get(key) || 0) + 1);
  perKey.set(key, (perKey.get(key) || 0) + 1);
  maxPerKey = Math.max(maxPerKey, inFlight.get(key));
  maxTotal = Math.max(maxTotal, [...inFlight.values()].reduce((a, b) => a + b, 0));
  await new Promise((r) => setTimeout(r, 60));
  inFlight.set(key, inFlight.get(key) - 1);
  const req = JSON.parse(init.body);
  const out = Object.fromEntries(req.generationConfig.responseSchema.required.map((l) => [l, { title: 't', description: 'd', tags: ['x'] }]));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), {
    headers: { 'content-type': 'application/json' },
  });
};

const { app } = require('../src/server');

test('listings are translated in parallel, one request at a time per API key', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const started = Date.now();
  const r = await realFetch(`${base}/api/etsy/translations/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listingIds: [0, 1, 2, 3, 4, 5, 6, 7, 8], languages: ['de'] }),
  });
  const { jobId } = await r.json();
  let job;
  do {
    await new Promise((res) => setTimeout(res, 10));
    job = await (await realFetch(`${base}/api/jobs/${jobId}`)).json();
  } while (job.status !== 'done');
  const elapsed = Date.now() - started;

  assert.equal(job.results.length, 9);
  assert.equal(maxTotal, 3, 'three keys work at the same time');
  assert.equal(maxPerKey, 1, 'each key sends one request at a time');
  assert.equal(perKey.size, 3, 'every key is used');
  assert.ok([...perKey.values()].every((n) => n >= 2), `work is spread over the keys: ${[...perKey.values()]}`);
  // The job reports listings done per key and what every key is doing.
  assert.equal(Object.values(job.perKey).reduce((a, b) => a + b, 0), 9);
  assert.deepEqual(job.keys.map((k) => [k.key, k.state]), [['key 1', 'ready'], ['key 2', 'ready'], ['key 3', 'ready']]);
  assert.ok(elapsed < 9 * 60, `parallel run took ${elapsed}ms`);
});
