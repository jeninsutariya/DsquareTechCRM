const { cleanTitle, cleanTags, decodeEntities } = require('./gemini');

// Google Cloud Translation (v2 Basic). Detects the source language automatically.
const API_URL = 'https://translation.googleapis.com/language/translate/v2';

// A Google API key works here if "Cloud Translation API" is enabled on its project,
// so the Gemini key is reused when no dedicated key is set.
const apiKey = () => process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GEMINI_API_KEY;

function cloudSetupProblem() {
  const key = apiKey();
  if (!key || key === 'your_gemini_api_key' || key === 'your_google_translate_api_key') {
    return 'GOOGLE_TRANSLATE_API_KEY is not set in .env.';
  }
  return null;
}

async function translateTexts(texts, target, attempt = 0) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    // No `source`: Google auto-detects the listing's language.
    body: JSON.stringify({ q: texts, target, format: 'text' }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return translateTexts(texts, target, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.error?.message || res.statusText;
    if (res.status === 403) {
      msg += ' (enable "Cloud Translation API" for this key\'s Google Cloud project, with billing on)';
    }
    throw new Error(`Google Cloud Translation ${res.status}: ${msg}`);
  }
  return data.data.translations.map((t) => t.translatedText);
}

/** Same contract as gemini.translateListing: { [code]: { title, description, tags } }. */
async function translateListing(listing, languages) {
  const tags = (listing.tags || []).map(decodeEntities);
  const texts = [decodeEntities(listing.title), decodeEntities(listing.description), ...tags];
  const out = {};
  for (const { code } of languages) {
    const [title, description, ...translatedTags] = await translateTexts(texts, code);
    out[code] = { title: cleanTitle(title), description: String(description).trim(), tags: cleanTags(translatedTags) };
  }
  return out;
}

module.exports = { translateListing, cloudSetupProblem };
