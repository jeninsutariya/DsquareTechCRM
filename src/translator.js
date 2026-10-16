const gemini = require('./gemini');
const { buildPrompt, buildDescriptionPrompt, cleanTitle, cleanTags, decodeEntities, looksUntranslated } = require('./listingText');

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
const BUSY_COOLDOWN_MS = 30 * 1000; // "model is overloaded" (503): skip that model briefly
const MAX_BUSY_PER_LISTING = 3; // after this many busy rounds on one model, move on for this listing

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
      chain.push({ id: `gemini|${i + 1}|${model}`, provider: 'gemini', model, key, keyNo: i + 1, label: `${model} · key ${i + 1}` });
    }
  });
  return chain;
}

// Limits learned while running (kept until the app restarts).
const cooldownUntil = new Map(); // combo id -> timestamp
const deadKeys = new Set(); // "provider|key": key rejected
const deadModels = new Set(); // "provider|model": model doesn't exist / unusable
const lastError = new Map(); // combo id -> last error message
const inFlight = new Map(); // key -> requests waiting or running on it

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

// Each API key sends one request at a time (its next request starts TRANSLATE_DELAY_MS after
// the previous one finished). Different keys run in parallel, which is what makes it fast.
const keyQueues = new Map(); // key -> promise chain
const delayMs = () => Number(process.env.TRANSLATE_DELAY_MS ?? 0);
function onKey(key, fn) {
  inFlight.set(key, (inFlight.get(key) || 0) + 1);
  const run = (keyQueues.get(key) || Promise.resolve()).then(fn);
  keyQueues.set(key, run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, delayMs()))));
  return run.finally(() => inFlight.set(key, inFlight.get(key) - 1));
}

/** Per-key overview: what each API key is doing and why it may be idle. */
function keyStatus() {
  const now = Date.now();
  const byKey = new Map();
  for (const c of buildChain()) {
    if (!byKey.has(c.keyNo)) byKey.set(c.keyNo, { key: `key ${c.keyNo}`, combos: [], busy: inFlight.get(c.key) || 0 });
    byKey.get(c.keyNo).combos.push(c);
  }
  return [...byKey.values()].map(({ key, combos, busy }) => {
    const alive = combos.filter((c) => !isDead(c));
    const ready = alive.filter((c) => !coolingFor(c, now));
    const reasons = combos.map((c) => lastError.get(c.id)).filter(Boolean);
    let state = 'ready';
    if (!alive.length) state = 'unavailable';
    else if (busy) state = 'working';
    else if (!ready.length) state = 'resting';
    const restSecs = ready.length ? 0 : Math.ceil(Math.min(...alive.map((c) => coolingFor(c, now)), Infinity) / 1000);
    return {
      key,
      state,
      readyModels: ready.map((c) => c.model),
      restSecs: Number.isFinite(restSecs) ? restSecs : 0,
      reason: state === 'ready' || state === 'working' ? null : reasons[reasons.length - 1] || null,
    };
  });
}

/** Number of API keys, used as the default number of listings translated in parallel. */
const keyCount = () => geminiKeys().length;

/** The chain, starting from key `start` (so parallel workers begin on different keys). */
function chainFrom(start) {
  const chain = buildChain();
  const keys = [...new Set(chain.map((c) => c.key))];
  if (keys.length < 2) return chain;
  const first = keys[start % keys.length];
  const at = chain.findIndex((c) => c.key === first);
  return [...chain.slice(at), ...chain.slice(0, at)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate one listing, moving along the chain on limits/errors.
 * Returns { translations, engine }. Throws StopError when every combination is used up,
 * or a normal Error if every usable combination failed on this listing's content.
 */
async function translateListing(listing, languages, { onAttempt, worker = 0 } = {}) {
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
  const busyCount = new Map(); // combo id -> busy errors on this listing
  const failures = [];
  const sourceDescription = decodeEntities(listing.description);

  for (;;) {
    const now = Date.now();
    const usable = chainFrom(worker).filter((c) => !isDead(c) && !triedHere.has(c.id));
    // Spread the work: take the key with the fewest requests in progress (ties keep chain order,
    // so each key's models are still tried in GEMINI_MODELS order).
    const available = usable.filter((c) => !coolingFor(c, now));
    const least = Math.min(...available.map((c) => inFlight.get(c.key) || 0));
    const combo = available.find((c) => (inFlight.get(c.key) || 0) === least);

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
      const raw = await onKey(combo.key, () => gemini.requestTranslation(combo, prompt, languages));
      const translations = {};
      for (const { code, name } of languages) {
        const t = raw?.[code];
        if (!t?.title || !t?.description) throw new gemini.ProviderError(`skipped language "${code}"`, 'content');
        let description = String(t.description).trim();
        if (looksUntranslated(listing.description, description)) {
          // Small models often copy a long description back; ask for just the description.
          description = await onKey(combo.key, () => gemini.requestText(combo, buildDescriptionPrompt(sourceDescription, name)));
          if (looksUntranslated(listing.description, description)) {
            throw new gemini.ProviderError(`description was not translated into "${code}"`, 'content');
          }
        }
        translations[code] = { title: cleanTitle(t.title), description, tags: cleanTags(t.tags) };
      }
      return { translations, engine: combo.label };
    } catch (err) {
      failures.push(`${combo.label}: ${err.message}`);
      lastError.set(combo.id, err.message);
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
        case 'busy': {
          // Temporary overload: pause this model briefly; other models are tried meanwhile,
          // and if every model is busy we wait instead of failing the listing.
          cooldownUntil.set(combo.id, Date.now() + BUSY_COOLDOWN_MS);
          const n = (busyCount.get(combo.id) || 0) + 1;
          busyCount.set(combo.id, n);
          if (n >= MAX_BUSY_PER_LISTING) triedHere.add(combo.id);
          break;
        }
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
  lastError.clear();
}

module.exports = { translateListing, setupProblem, chainStatus, keyStatus, resetLimits, keyCount, StopError, DEFAULT_GEMINI_MODELS };
