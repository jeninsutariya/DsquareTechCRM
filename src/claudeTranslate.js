const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { buildPrompt, cleanTitle, cleanTags, decodeEntities } = require('./listingText');

const DEFAULT_MODEL = 'claude-opus-5-5';

function claudeSetupProblem() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_api_key') {
    return 'ANTHROPIC_API_KEY is not set in .env. Get a key at https://platform.claude.com/settings/keys';
  }
  return null;
}

let client;
function getClient() {
  // Created lazily so .env is loaded first; reads ANTHROPIC_API_KEY from the environment.
  client ??= new Anthropic({ maxRetries: 4 });
  return client;
}

/**
 * Translate one Etsy listing into several languages with Claude.
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

  let message;
  try {
    // Streaming: several full descriptions can be a long response.
    message = await getClient()
      .beta.messages.stream({
        model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
        max_tokens: 64000,
        // If Claude declines on safety grounds, the API retries on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: zodOutputFormat(schema) },
        messages: [{ role: 'user', content: buildPrompt(source, languages) }],
      })
      .finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude API key is invalid. Check ANTHROPIC_API_KEY in .env.');
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new Error(`Claude model not found: ${err.message} (check CLAUDE_MODEL in .env)`);
    }
    if (err instanceof Anthropic.APIError) throw new Error(`Claude ${err.status ?? ''}: ${err.message}`.trim());
    throw err;
  }

  if (message.stop_reason === 'refusal') throw new Error('Claude declined to translate this listing');
  if (message.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (listing too long)');

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try {
    result = schema.parse(JSON.parse(text));
  } catch {
    throw new Error('Claude returned invalid JSON');
  }

  const out = {};
  for (const { code } of languages) {
    const t = result[code];
    out[code] = { title: cleanTitle(t.title), description: t.description.trim(), tags: cleanTags(t.tags) };
  }
  return out;
}

module.exports = { translateListing, claudeSetupProblem, DEFAULT_MODEL };
