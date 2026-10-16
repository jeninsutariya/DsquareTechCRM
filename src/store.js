const fs = require('node:fs');
const path = require('node:path');

// Simple JSON-file persistence; swap for a real database when the CRM grows one.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'etsy.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function update(patch) {
  const next = { ...load(), ...patch };
  save(next);
  return next;
}

function clear() {
  fs.rmSync(FILE, { force: true });
}

module.exports = { load, save, update, clear };
