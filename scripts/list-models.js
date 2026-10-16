// Lists the Gemini models each API key in .env can use for translation.
// Usage: npm run models
const { loadEnv } = require('../src/env');

loadEnv();

const keys = Object.keys(process.env)
  .map((k) => k.match(/^GEMINI_API_KEY_(\d+)$/))
  .filter(Boolean)
  .sort((a, b) => Number(a[1]) - Number(b[1]))
  .map((m) => [m[0], process.env[m[0]]?.trim()])
  .filter(([, v]) => v && !/^your_/.test(v));

if (process.env.GEMINI_API_KEY?.trim()) keys.unshift(['GEMINI_API_KEY', process.env.GEMINI_API_KEY.trim()]);
if (!keys.length) {
  console.log('No GEMINI_API_KEY_1..5 found in .env');
  process.exit(1);
}

(async () => {
  for (const [name, key] of keys) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': key },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`\n${name}: ERROR ${res.status} ${data.error?.message || res.statusText}`);
      continue;
    }
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/.test(n) && !/embedding|image|tts|audio|live/.test(n));
    console.log(`\n${name}: ${models.length} Gemini text models`);
    for (const m of models) console.log(`  ${m}`);
  }
  console.log('\nCopy the names you want, in order, into GEMINI_MODELS in .env (comma separated).');
})();
