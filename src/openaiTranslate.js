const OpenAI = require('openai');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const { buildPrompt, cleanTitle, cleanTags, decodeEntities } = require('./listingText');

const DEFAULT_MODEL = 'gpt-5.5';

function openaiSetupProblem() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === 'your_openai_api_key') {
    return 'OPENAI_API_KEY is not set in .env. Get a key at https://platform.openai.com/api-keys';
  }
  return null;
}

let client;
function getClient() {
  // Created lazily so .env is loaded first; reads OPENAI_API_KEY from the environment.
  client ??= new OpenAI({ maxRetries: 4 });
  return client;
}

/**
 * Translate one Etsy listing into several languages with OpenAI (ChatGPT).
 * Returns { [code]: { title, description, tags } }.
 */
async function translateListing(listing, languages) {
  const entry = z.object({ title: z.string(), description: z.string(), tags: z.array(z.string()) });
  const schema = z.object(Object.fromEntries(languages.map((l) => [l.code, entry])));
  const source = {
    language: listing.language,
    title: decodeEntities(listing.title),
    description: decodeEntities(listing.description),
    tags: (listing.tags || []).map(decodeEntities),
  };

  let response;
  try {
    response = await getClient().responses.parse({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      input: buildPrompt(source, languages),
      text: { format: zodTextFormat(schema, 'listing_translations') },
    });
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      throw new Error('OpenAI API key is invalid. Check OPENAI_API_KEY in .env.');
    }
    if (err instanceof OpenAI.NotFoundError) {
      throw new Error(`OpenAI model not found: ${err.message} (check OPENAI_MODEL in .env)`);
    }
    if (err instanceof OpenAI.APIError) throw new Error(`OpenAI ${err.status ?? ''}: ${err.message}`.trim());
    throw err;
  }

  if (response.status === 'incomplete') {
    throw new Error(`OpenAI response was cut off (${response.incomplete_details?.reason || 'incomplete'})`);
  }
  const refusal = response.output
    ?.flatMap((item) => item.content || [])
    .find((c) => c.type === 'refusal');
  if (refusal) throw new Error(`OpenAI declined to translate this listing: ${refusal.refusal}`);

  const result = response.output_parsed;
  if (!result) throw new Error('OpenAI returned no translation');

  const out = {};
  for (const { code } of languages) {
    const t = result[code];
    out[code] = { title: cleanTitle(t.title), description: t.description.trim(), tags: cleanTags(t.tags) };
  }
  return out;
}

module.exports = { translateListing, openaiSetupProblem, DEFAULT_MODEL };
