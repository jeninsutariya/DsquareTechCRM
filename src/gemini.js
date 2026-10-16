const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.6-flash';

// Etsy listing limits.
const MAX_TITLE = 140;
const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;

function geminiSetupProblem() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key') {
    return 'GEMINI_API_KEY is not set in .env. Get a key at https://aistudio.google.com/apikey and restart the app.';
  }
  return null;
}

/** Etsy returns titles/descriptions HTML-escaped; give the model plain text. */
function decodeEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TITLE) {
    t = t.slice(0, MAX_TITLE);
    const cut = t.lastIndexOf(' ');
    if (cut > MAX_TITLE * 0.6) t = t.slice(0, cut);
    t = t.replace(/[\s,|\-–]+$/, '');
  }
  return t;
}

/** Keep tags Etsy will accept: letters/numbers/space/-'™©®, ≤20 chars, unique, ≤13. */
function cleanTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw)
      .replace(/[^\p{L}\p{M}\p{N} \-'™©®]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = tag.toLowerCase();
    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

function buildPrompt(listing, languages) {
  const targets = languages.map((l) => `${l.code} (${l.name})`).join(', ');
  return `You are an expert Etsy SEO copywriter and native-level translator.
Translate this Etsy listing into: ${targets}.

Rules:
- Write naturally for shoppers in each language, using words they actually search for on Etsy. Do not translate word-for-word.
- Title: at most ${MAX_TITLE} characters. Put the most important keywords first.
- Description: translate the full text. Keep paragraphs, line breaks, bullet points, emojis, measurements, sizes, numbers and URLs exactly as they are.
- Tags: exactly ${MAX_TAGS} search tags if possible, each at most ${MAX_TAG_LENGTH} characters, only letters, numbers, spaces, hyphens and apostrophes. Localize them as shoppers would search, not literal translations.
- Do not translate brand names, the shop name, or product codes/SKUs.
- Return only the JSON object.

Listing (source language: ${listing.language || 'unknown'}):
TITLE:
${listing.title}

DESCRIPTION:
${listing.description}

TAGS:
${listing.tags.join(', ')}`;
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

async function generate(prompt, schema, attempt = 0) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: schema },
    }),
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return generate(prompt, schema, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.error?.message || res.statusText;
    if (res.status === 404) msg += ` (model "${model}" not found; set GEMINI_MODEL in .env)`;
    if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) msg = 'Gemini API key is invalid. Check GEMINI_API_KEY in .env.';
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response';
    throw new Error(`Gemini returned no translation (${reason})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini returned invalid JSON');
  }
}

/**
 * Translate one Etsy listing into several languages in a single Gemini call.
 * `languages` is [{ code, name }]. Returns { [code]: { title, description, tags } }.
 */
async function translateListing(listing, languages) {
  const source = {
    language: listing.language,
    title: decodeEntities(listing.title),
    description: decodeEntities(listing.description),
    tags: (listing.tags || []).map(decodeEntities),
  };
  const result = await generate(buildPrompt(source, languages), responseSchema(languages));
  const out = {};
  for (const { code } of languages) {
    const t = result[code];
    if (!t?.title || !t?.description) throw new Error(`Gemini skipped language "${code}"`);
    out[code] = { title: cleanTitle(t.title), description: String(t.description).trim(), tags: cleanTags(t.tags) };
  }
  return out;
}

module.exports = { translateListing, geminiSetupProblem, cleanTags, cleanTitle, decodeEntities, DEFAULT_MODEL };
