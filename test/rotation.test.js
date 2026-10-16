const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-test-'));
process.env.ETSY_API_KEY = 'key123';
process.env.ETSY_REDIRECT_URI = 'http://localhost/auth/etsy/callback';
process.env.GEMINI_API_KEY_1 = 'k1';
process.env.GEMINI_API_KEY_2 = 'k2';
process.env.GEMINI_MODELS = 'm-a,m-b,m-c';
process.env.TRANSLATE_DELAY_MS = '0';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

// Six listings already synced from a connected shop.
fs.writeFileSync(path.join(process.env.DATA_DIR, 'etsy.json'), JSON.stringify({
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3 },
  scopes: ['listings_r', 'listings_w'],
  shop: { shop_id: 7, shop_name: 'Test' },
  listings: Array.from({ length: 6 }, (_, i) => ({
    listing_id: i, language: 'en-US', title: `Listing ${i}`, description: `Description ${i}`, tags: ['tag'], state: 'active',
  })),
}));

const calls = []; // "key/model" per Gemini request, in order
const successes = new Map();
let mode = 'normal';
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const dailyLimit = () => json({
  error: {
    code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_requests_per_model_per_day',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '40s' }],
  },
}, 429);

const realFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  const model = url.pathname.match(/models\/(.+):generateContent$/)[1];
  const key = init.headers['x-goog-api-key'];
  const combo = `${key}/${model}`;
  calls.push(combo);

  if (mode === 'badkeys') return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, 400);
  if (model === 'm-b') return json({ error: { code: 404, message: `models/${model} is not found` } }, 404);
  if (combo === 'k1/m-c') {
    return json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
  }
  const allowed = { 'k1/m-a': 2, 'k2/m-a': 1, 'k2/m-c': 1 }[combo] ?? 0;
  const used = successes.get(combo) || 0;
  if (used >= allowed) return dailyLimit();
  successes.set(combo, used + 1);
  const req = JSON.parse(init.body);
  const out = Object.fromEntries(req.generationConfig.responseSchema.required.map((l) => [l, { title: `${l} via ${combo}`, description: 'd', tags: ['t'] }]));
  return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
};

const { app } = require('../src/server');
const translator = require('../src/translator');

async function generate(base, listingIds) {
  const r = await realFetch(`${base}/api/etsy/translations/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingIds, languages: ['de'] }),
  });
  const { jobId } = await r.json();
  for (;;) {
    const job = await (await realFetch(`${base}/api/jobs/${jobId}`)).json();
    if (job.status === 'done') return job;
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('switches model, then API key, on limits; retries the same listing; stops when all are used up', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const job = await generate(base, [0, 1, 2, 3, 4, 5]);

  assert.deepEqual(job.results.map((r) => [r.listing_id, r.engine]), [
    [0, 'm-a · key 1'],
    [1, 'm-a · key 1'],
    [2, 'm-a · key 2'], // k1/m-a daily limit, m-b missing, k1/m-c bad output -> key 2
    [3, 'm-c · key 2'], // k2/m-a daily limit -> next model
  ]);
  assert.equal(job.results[2].translations.de.title, 'de via k2/m-a');
  assert.deepEqual(job.errors, [], 'no listing fails just because a limit was reached');
  assert.match(job.stopped, /reached their limits/);
  assert.deepEqual(job.notProcessed.map((l) => l.listing_id), [4, 5]);
  assert.equal(job.done, 4);

  assert.deepEqual(calls, [
    'k1/m-a', 'k1/m-a',
    'k1/m-a', 'k1/m-b', 'k1/m-c', 'k2/m-a', // listing 2 (m-b now known missing for every key)
    'k1/m-c', 'k2/m-a', 'k2/m-c', // listing 3
    'k1/m-c', 'k2/m-c', // listing 4: everything left is at its daily limit -> stop
  ]);

  const status = await (await realFetch(`${base}/api/etsy/status`)).json();
  assert.deepEqual(status.translatorChain.map((c) => c.state), [
    'limit reached', 'unavailable', 'ready', 'limit reached', 'unavailable', 'limit reached',
  ]);
});

test('stops right away when every API key is invalid', async (t) => {
  translator.resetLimits();
  mode = 'badkeys';
  calls.length = 0;
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const job = await generate(base, [0, 1, 2]);
  assert.deepEqual(job.results, []);
  assert.match(job.stopped, /unavailable/);
  assert.deepEqual(job.notProcessed.map((l) => l.listing_id), [0, 1, 2]);
  assert.deepEqual(calls, ['k1/m-a', 'k2/m-a']); // one try per key, then each key is skipped
});
