// Text helpers shared by listing translation: Etsy limits, cleanup, and the prompt.

// Etsy listing limits.
const MAX_TITLE = 140;
const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;

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
- Description: translate the FULL description into the target language. Never return it in the original language. Keep paragraphs, line breaks, bullet points, emojis, measurements, sizes, numbers and URLs exactly as they are.
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

/**
 * True when a "translated" description is really the source text copied back
 * (ignoring case, spacing and URLs). Short descriptions are not checked.
 */
function looksUntranslated(sourceDescription, translatedDescription) {
  const norm = (s) => decodeEntities(s).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const src = norm(sourceDescription);
  if ((src.match(/\p{L}/gu) || []).length < 30) return false;
  return src === norm(translatedDescription);
}

module.exports = { buildPrompt, cleanTitle, cleanTags, decodeEntities, looksUntranslated };
