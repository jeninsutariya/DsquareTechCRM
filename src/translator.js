const gemini = require('./gemini');
const { buildPrompt, cleanTitle, cleanTags, decodeEntities } = require('./listingText');

/**
 * Translation runs through a chain of (API key × model) combinations:
 * key 1 with every model in GEMINI_MODELS order, then key 2 with every model, ...
 * and so on. When a combination hits its limit,
 * the same listing is retried on the next one, so no listing is skipped. When
 * every combination is used up, translating stops (StopError).
 */
const DEFAULT_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
];
const SHORT_COOLDOWN_MS = 60 * 1000; // per-minute limits
const LONG_COOLDOWN_MS = 24 * 60 * 60 * 1000; // daily limits
const MAX_WAIT_MS = 65 * 1000; // wait for a per-minute limit to clear rather than stop

class StopError extends Error {
  constructor(message) {
    super(message);
    this.stopJob = true;
  }
}

const isPlaceholder = (v) => !v || /^your_/.test(v);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function geminiKeys() {
  const numbered = Object.keys(process.env)
    .map((k) => k.match(/^GEMINI_API_KEY_(\d+)$/))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => process.env[m[0]]);
  const keys = [...list(process.env.GEMINI_API_KEYS), process.env.GEMINI_API_KEY, ...numbered];
  return [...new Set(keys.map((k) => k?.trim()).filter((k) => !isPlaceholder(k)))];
}

function buildChain() {
  const models = list(process.env.GEMINI_MODELS);
  const chain = [];
  geminiKeys().forEach((key, i) => {
    for (const model of models.length ? models : DEFAULT_GEMINI_MODELS) {
      chain.push({ id: `gemini|${i + 1}|${model}`, provider: 'gemini', model, key, label: `${model} · key ${i + 1}` });
    }
  });
  return chain;
}

// Limits learned while running (kept until the app restarts).
const cooldownUntil = new Map(); // combo id -> timestamp
const deadKeys = new Set(); // "provider|key": key rejected
const deadModels = new Set(); // "provider|model": model doesn't exist / unusable

const isDead = (c) => deadKeys.has(`${c.provider}|${c.key}`) || deadModels.has(`${c.provider}|${c.model}`);
const coolingFor = (c, now) => Math.max(0, (cooldownUntil.get(c.id) || 0) - now);

function setupProblem() {
  if (buildChain().length) return null;
  return 'No translation API key in .env. Add GEMINI_API_KEY_1 (up to GEMINI_API_KEY_5), then restart the app.';
}

/** Chain overview for the dashboard. */
function chainStatus() {
  const now = Date.now();
  return buildChain().map((c) => ({
    label: c.label,
    state: isDead(c) ? 'unavailable' : coolingFor(c, now) ? 'limit reached' : 'ready',
  }));
}

// One request at a time; the next starts TRANSLATE_DELAY_MS (default 1s) after the previous finished.
let queue = Promise.resolve();
const delayMs = () => Number(process.env.TRANSLATE_DELAY_MS ?? 1000);
function oneAtATime(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, delayMs())));
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate one listing, moving along the chain on limits/errors.
 * Returns { translations, engine }. Throws StopError when every combination is used up,
 * or a normal Error if every usable combination failed on this listing's content.
 */
async function translateListing(listing, languages, { onAttempt } = {}) {
  const prompt = buildPrompt(
    {
      language: listing.language,
      title: decodeEntities(listing.title),
      description: decodeEntities(listing.description),
      tags: (listing.tags || []).map(decodeEntities),
    },
    languages,
  );
  const triedHere = new Set(); // combos that failed on this listing for non-limit reasons
  const failures = [];

  for (;;) {
    const now = Date.now();
    const usable = buildChain().filter((c) => !isDead(c) && !triedHere.has(c.id));
    const combo = usable.find((c) => !coolingFor(c, now));

    if (!combo) {
      if (!usable.length) {
        if (!buildChain().some((c) => !isDead(c))) {
          throw new StopError('All API keys and models are unavailable (invalid key or model name).');
        }
        throw new Error(`Translation failed on every model: ${failures.slice(-3).join(' | ')}`);
      }
      const wait = Math.min(...usable.map((c) => coolingFor(c, now)));
      if (wait > MAX_WAIT_MS) throw new StopError('All API keys and models have reached their limits.');
      await sleep(wait);
      continue;
    }

    onAttempt?.(combo.label);
    try {
      const raw = await oneAtATime(() => gemini.requestTranslation(combo, prompt, languages));
      const translations = {};
      for (const { code } of languages) {
        const t = raw?.[code];
        if (!t?.title || !t?.description) throw new gemini.ProviderError(`skipped language "${code}"`, 'content');
        translations[code] = { title: cleanTitle(t.title), description: String(t.description).trim(), tags: cleanTags(t.tags) };
      }
      return { translations, engine: combo.label };
    } catch (err) {
      failures.push(`${combo.label}: ${err.message}`);
      console.warn(`[translate] listing ${listing.listing_id} on ${combo.label}: ${err.message}`);
      switch (err.kind) {
        case 'quota':
          cooldownUntil.set(combo.id, Date.now() + (err.long ? LONG_COOLDOWN_MS : Math.max(err.retryAfterMs || 0, SHORT_COOLDOWN_MS)));
          break;
        case 'key':
          deadKeys.add(`${combo.provider}|${combo.key}`);
          break;
        case 'model':
          deadModels.add(`${combo.provider}|${combo.model}`);
          break;
        default: // transient or bad output: try the next combination for this listing
          triedHere.add(combo.id);
      }
    }
  }
}

/** Forget learned limits (used by tests). */
function resetLimits() {
  cooldownUntil.clear();
  deadKeys.clear();
  deadModels.clear();
}

module.exports = { translateListing, setupProblem, chainStatus, resetLimits, StopError, DEFAULT_GEMINI_MODELS };
