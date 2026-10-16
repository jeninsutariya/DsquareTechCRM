const OpenAI = require('openai');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const { ProviderError } = require('./gemini');

// One client per API key; retries are handled by the translator's model/key rotation.
const clients = new Map();
function clientFor(key) {
  if (!clients.has(key)) clients.set(key, new OpenAI({ apiKey: key, maxRetries: 1 }));
  return clients.get(key);
}

/** One OpenAI request. Returns the raw { [code]: { title, description, tags } } object. */
async function requestTranslation({ model, key }, prompt, languages) {
  const entry = z.object({ title: z.string(), description: z.string(), tags: z.array(z.string()) });
  const schema = z.object(Object.fromEntries(languages.map((l) => [l.code, entry])));

  let response;
  try {
    response = await clientFor(key).responses.parse({
      model,
      input: prompt,
      text: { format: zodTextFormat(schema, 'listing_translations') },
    });
  } catch (err) {
    if (err instanceof OpenAI.RateLimitError) {
      const long = err.code === 'insufficient_quota';
      const retryAfter = Number(err.headers?.get?.('retry-after'));
      throw new ProviderError(`limit reached: ${err.message}`, 'quota', {
        long,
        retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : null,
      });
    }
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      throw new ProviderError(`API key rejected: ${err.message}`, 'key');
    }
    if (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.BadRequestError) {
      throw new ProviderError(`model unavailable: ${err.message}`, 'model');
    }
    throw new ProviderError(err.message, 'transient');
  }

  if (response.status === 'incomplete') {
    throw new ProviderError(`response cut off (${response.incomplete_details?.reason || 'incomplete'})`, 'content');
  }
  const refusal = response.output?.flatMap((item) => item.content || []).find((c) => c.type === 'refusal');
  if (refusal) throw new ProviderError(`declined: ${refusal.refusal}`, 'content');
  if (!response.output_parsed) throw new ProviderError('no translation returned', 'content');
  return response.output_parsed;
}

module.exports = { requestTranslation };
