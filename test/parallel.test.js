const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-test-'));
process.env.ETSY_API_KEY = 'testkeystring0123456789ab';
process.env.ETSY_REDIRECT_URI = 'http://localhost/auth/etsy/callback';
process.env.GEMINI_API_KEY_1 = 'k1';
process.env.GEMINI_API_KEY_2 = 'k2';
process.env.GEMINI_API_KEY_3 = 'k3';
process.env.GEMINI_MODELS = 'm';
process.env.TRANSLATE_DELAY_MS = '0';
delete process.env.TRANSLATE_CONCURRENCY;
process.env.TRANSLATE_PER_KEY = '2';
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

fs.writeFileSync(path.join(process.env.DATA_DIR, 'etsy.json'), JSON.stringify({
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3 },
  scopes: ['listings_r', 'listings_w'],
  shop: { shop_id: 7, shop_name: 'Test' },
  listings: [
    ...Array.from({ length: 9 }, (_, i) => ({
      listing_id: i, language: 'en-US', title: `Listing ${i}`, description: `Description ${i}`, tags: ['tag'], state: 'active',
    })),
    // Listings whose long English description the model copies back in the big request.
    ...Array.from({ length: 4 }, (_, i) => ({
      listing_id: 100 + i, language: 'en-US', title: `Copy ${i}`, tags: ['tag'], state: 'active',
      description: `COPYME Hand cut wooden sign number ${i}, sanded and oiled, ready to hang on any wall.`,
    })),
  ],
}));

const inFlight = new Map(); // key -> requests running now
let maxTotal = 0;
const jsonRequests = []; // { copy, askedDescription }
let textMax = 0;
let textNow = 0;
let maxPerKey = 0;
const perKey = new Map();
const realFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const key = init.headers['x-goog-api-key'];
  if (JSON.parse(init.body).generationConfig.responseMimeType === 'text/plain') {
    textNow++;
    textMax = Math.max(textMax, textNow);
  }
  inFlight.set(key, (inFlight.get(key) || 0) + 1);
  perKey.set(key, (perKey.get(key) || 0) + 1);
  maxPerKey = Math.max(maxPerKey, inFlight.get(key));
  maxTotal = Math.max(maxTotal, [...inFlight.values()].reduce((a, b) => a + b, 0));
  await new Promise((r) => setTimeout(r, 60));
  inFlight.set(key, inFlight.get(key) - 1);
  const req = JSON.parse(init.body);
  const prompt = req.contents[0].parts[0].text;
  const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    headers: { 'content-type': 'application/json' },
  });
  if (req.generationConfig.responseMimeType === 'text/plain') {
    textNow--;
    return reply(`translated: ${prompt.match(/into (\w+)\./)[1]}`);
  }
  const copy = prompt.includes('COPYME');
  const schema = req.generationConfig.responseSchema;
  const askedDescription = schema.properties[schema.required[0]].required.includes('description');
  jsonRequests.push({ copy, askedDescription });
  const source = prompt.match(/DESCRIPTION:\n([^\n]*)/)[1];
  const out = Object.fromEntries(schema.required.map((l) => [l, { title: 't', description: copy ? source : 'd', tags: ['x'] }]));
  return reply(JSON.stringify(out));
};

const { app } = require('../src/server');

async function generate(base, listingIds, languages) {
  const r = await realFetch(`${base}/api/etsy/translations/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listingIds, languages }),
  });
  const { jobId } = await r.json();
  let job;
  do {
    await new Promise((res) => setTimeout(res, 10));
    job = await (await realFetch(`${base}/api/jobs/${jobId}`)).json();
  } while (job.status !== 'done');
  return job;
}

test('listings are translated in parallel, up to TRANSLATE_PER_KEY requests per API key', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const started = Date.now();
  const job = await generate(base, [0, 1, 2, 3, 4, 5, 6, 7, 8], ['de']);
  const elapsed = Date.now() - started;

  assert.equal(job.results.length, 9);
  assert.equal(maxTotal, 6, 'three keys x two requests work at the same time');
  assert.equal(maxPerKey, 2, 'never more than TRANSLATE_PER_KEY requests on one key');
  assert.equal(perKey.size, 3, 'every key is used');
  assert.ok([...perKey.values()].every((n) => n >= 2), `work is spread over the keys: ${[...perKey.values()]}`);
  // The job reports listings done per key and what every key is doing.
  assert.equal(Object.values(job.perKey).reduce((a, b) => a + b, 0), 9);
  assert.deepEqual(job.keys.map((k) => [k.key, k.state]), [['key 1', 'ready'], ['key 2', 'ready'], ['key 3', 'ready']]);
  assert.ok(elapsed < 9 * 60, `parallel run took ${elapsed}ms (one at a time would take 540ms+)`);
});

test('copied English descriptions are re-translated in parallel; the model stops being asked for them', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  jsonRequests.length = 0;

  const first = await generate(base, [100, 101], ['de', 'fr', 'es', 'it']);
  const second = await generate(base, [102, 103], ['de', 'fr', 'es', 'it']);
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(first.results.length + second.results.length, 4);

  const drafts = await (await realFetch(`${base}/api/etsy/drafts`)).json();
  for (const d of drafts.listings.filter((x) => x.listing_id >= 100)) {
    assert.deepEqual(Object.values(d.langs).map((l) => l.description).sort(),
      ['translated: French', 'translated: German', 'translated: Italian', 'translated: Spanish']);
  }
  assert.ok(textMax >= 3, `description requests ran in parallel (max ${textMax} at once)`);
  // After two copies the big request no longer asks this model for descriptions.
  assert.deepEqual(jsonRequests.map((r) => r.askedDescription), [true, true, false, false]);
});
