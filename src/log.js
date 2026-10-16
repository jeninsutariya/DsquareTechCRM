const fs = require('node:fs');
const path = require('node:path');

// Activity log for translating and publishing: kept in memory for the dashboard
// (newest MAX entries) and appended to data/translate-log.txt.
const MAX = 3000;
const entries = [];
let seq = 0;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'translate-log.txt');

/** level: 'info' | 'ok' | 'warn' | 'error' */
function add(level, message) {
  const entry = { seq: ++seq, time: new Date().toISOString(), level, message };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${message}`;
  (level === 'error' || level === 'warn' ? console.warn : console.log)(`[translate] ${message}`);
  fs.mkdir(DATA_DIR, { recursive: true }, () => fs.appendFile(FILE, `${line}\n`, () => {}));
  return entry;
}

/** Entries after `since` (a seq number), at most `limit` of the newest. */
function since(since = 0, limit = 500) {
  const out = entries.filter((e) => e.seq > since);
  return out.slice(-limit);
}

const lastSeq = () => seq;

module.exports = { add, since, lastSeq, FILE };
