const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
// Names editors commonly save `.env` as by mistake (e.g. macOS TextEdit).
const MISNAMED = ['.env.txt', '.env.rtf', 'env', 'env.txt', '.env.example.txt'];

/**
 * Load `.env` from the project root no matter which directory or command the
 * app is started from. Variables already set in the environment win.
 */
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Human-readable reason the Etsy settings are unusable, or null if they look fine. */
function etsySetupProblem() {
  const key = process.env.ETSY_API_KEY;
  if (!fs.existsSync(ENV_FILE) && !key) {
    const wrong = MISNAMED.find((f) => fs.existsSync(path.join(ROOT, f)));
    if (wrong) {
      return `Found "${wrong}" but the file must be named exactly ".env". Rename it in ${ROOT}.`;
    }
    return `No .env file found in ${ROOT}. Copy .env.example to .env and add your Etsy keys.`;
  }
  if (!key || key === 'your_keystring') {
    return 'ETSY_API_KEY is not set in .env. Paste your Etsy app Keystring after "ETSY_API_KEY=".';
  }
  if (process.env.ETSY_SHARED_SECRET === 'your_shared_secret') {
    return 'ETSY_SHARED_SECRET still has the example value in .env. Paste your Etsy app Shared Secret.';
  }
  if (!process.env.ETSY_REDIRECT_URI) {
    return 'ETSY_REDIRECT_URI is empty in .env. Set it to http://localhost:3000/auth/etsy/callback.';
  }
  return null;
}

module.exports = { loadEnv, etsySetupProblem, ENV_FILE };
