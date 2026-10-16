const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Error with a `kind` the translator uses to decide what to try next. */
class ProviderError extends Error {
  constructor(message, kind, extra = {}) {
    super(message);
    this.kind = kind; // 'quota' | 'key' | 'model' | 'busy' | 'transient' | 'content'
    Object.assign(this, extra);
  }
}

function responseSchema(languages) {
  const entry = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      description: { type: 'STRING' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['title', 'description', 'tags'],
  };
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(languages.map((l) => [l.code, entry])),
    required: languages.map((l) => l.code),
  };
}

/** Parse Google's RetryInfo ("37s") into milliseconds. */
function retryDelayMs(error) {
  const info = (error?.details || []).find((d) => String(d['@type']).includes('RetryInfo'));
  const secs = parseFloat(info?.retryDelay);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

const BUSY_RETRY_DELAYS_MS = [2000, 5000]; // "model is overloaded" (503/500): retry the same model briefly
const busyDelays = () => (process.env.GEMINI_BUSY_RETRY_MS ? list(process.env.GEMINI_BUSY_RETRY_MS) : BUSY_RETRY_DELAYS_MS);
const list = (v) => String(v).split(',').map(Number).filter((n) => n >= 0);

/** One generateContent call with error classification. Returns the response text. */
async function generate({ model, key }, prompt, generationConfig) {
  const delays = busyDelays();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
      });
    } catch (err) {
      throw new ProviderError(`network error: ${err.message}`, 'transient');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || res.statusText;
      const raw = JSON.stringify(data.error || {});
      if (res.status === 429) {
        // Daily quota, or a model this key may not use at all ("limit: 0"), lasts long; per-minute limits pass.
        const long = /PerDay|per day|limit: 0\b/i.test(raw);
        throw new ProviderError(`limit reached: ${msg}`, 'quota', { long, retryAfterMs: retryDelayMs(data.error) });
      }
      if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID|location is not supported/i.test(msg)) {
        throw new ProviderError(`API key rejected: ${msg}`, 'key');
      }
      if (res.status === 404 || res.status === 400) throw new ProviderError(`model unavailable: ${msg}`, 'model');
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw new ProviderError(`${res.status}: ${msg}`, 'busy');
    }

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response';
      throw new ProviderError(`no translation returned (${reason})`, 'content');
    }
    return text;
  }
}

/** Title, description and tags for several languages in one call: { [code]: { title, description, tags } }. */
async function requestTranslation(combo, prompt, languages) {
  const text = await generate(combo, prompt, {
    temperature: 0.3,
    responseMimeType: 'application/json',
    responseSchema: responseSchema(languages),
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('invalid JSON returned', 'content');
  }
}

/** Plain-text call (used to translate a single description). */
async function requestText(combo, prompt) {
  const text = await generate(combo, prompt, { temperature: 0.2, responseMimeType: 'text/plain' });
  return text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
}

module.exports = { requestTranslation, requestText, ProviderError };
