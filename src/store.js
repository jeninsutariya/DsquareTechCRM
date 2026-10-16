const fs = require('node:fs');
const path = require('node:path');

// Simple JSON-file persistence; swap for a real database when the CRM grows one.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function createStore(filename) {
  const file = path.join(DATA_DIR, filename);

  function load() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  function save(data) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function update(patch) {
    const next = { ...load(), ...patch };
    save(next);
    return next;
  }

  function clear() {
    fs.rmSync(file, { force: true });
  }

  return { load, save, update, clear };
}

// Shop, tokens, listings and published-translation records.
const main = createStore('etsy.json');
// Generated translations waiting to be published: { [listingId]: { [lang]: draft } }.
const drafts = createStore('drafts.json');

module.exports = { ...main, drafts };
