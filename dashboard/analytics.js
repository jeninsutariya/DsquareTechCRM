/*
 * Revenue analytics core: parses spreadsheet rows into clean (date, app, revenue)
 * records and computes every KPI, table and chart series from them.
 * Nothing here is hardcoded to a particular file — columns are detected by header.
 * Works in the browser (window.RevenueAnalytics) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RevenueAnalytics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_LOOKUP = MONTHS.reduce((m, name, i) => { m[name.toLowerCase()] = i; return m; }, {});

  // ---------- small safe helpers ----------

  const pad = (n) => String(n).padStart(2, '0');
  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
  const safeDiv = (a, b) => (b > 0 && Number.isFinite(a) ? a / b : 0);

  // Kahan summation keeps long float sums accurate to the cent.
  function sum(values) {
    let total = 0, c = 0;
    for (const v of values) {
      if (!isFiniteNumber(v)) continue;
      const y = v - c; const t = total + y; c = (t - total) - y; total = t;
    }
    return total;
  }

  function keyFromUTC(d) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function dateFromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function addDays(key, n) { return keyFromUTC(new Date(dateFromKey(key).getTime() + n * DAY_MS)); }
  function weekStart(key) { // Monday-based week
    const d = dateFromKey(key); const dow = (d.getUTCDay() + 6) % 7;
    return addDays(key, -dow);
  }
  function localTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function validYMD(y, m, d) {
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? keyFromUTC(dt) : null;
  }

  /** Converts an Excel serial, Date or date-like string into 'YYYY-MM-DD', or null. */
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // SheetJS Dates carry local midnight; round to the nearest day to absorb TZ offsets.
      return validYMD(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    if (isFiniteNumber(v)) {
      if (v < 1 || v > 200000) return null; // Excel serial day range
      const d = new Date(Math.round(v - 25569) * DAY_MS); // 25569 = serial of 1970-01-01
      return validYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
      // Ambiguous d/m vs m/d: prefer day-first unless that is impossible.
      return validYMD(+m[3], +m[2], +m[1]) || validYMD(+m[3], +m[1], +m[2]);
    }
    if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{4})$/))) {
      const mi = MONTH_LOOKUP[m[2].toLowerCase()];
      return mi === undefined ? null : validYMD(+m[3], mi + 1, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
      const mi = MONTH_LOOKUP[m[1].toLowerCase()];
      return mi === undefined ? null : validYMD(+m[3], mi + 1, +m[2]);
    }
    return null;
  }

  /** Parses a revenue cell. Returns a finite number, or null when the cell is empty/invalid. */
  function parseAmount(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s || /^[-–—]+$/.test(s) || /^(n\/?a|null|nan|none)$/i.test(s)) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    s = s.replace(/[^0-9.,\-eE]/g, '');
    if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
    else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    const n = Number(s);
    if (!Number.isFinite(n) || s === '') return null;
    return negative ? -Math.abs(n) : n;
  }

  // ---------- column detection ----------

  const norm = (h) => String(h === null || h === undefined ? '' : h).trim().toLowerCase();

  function detectColumns(header) {
    const h = header.map(norm);
    const find = (tests) => {
      for (const t of tests) { const i = h.findIndex(t); if (i !== -1) return i; }
      return -1;
    };
    const date = find([(x) => x === 'date', (x) => /\bdate\b/.test(x), (x) => /\b(day|dt)\b/.test(x)]);
    const appId = find([(x) => /\bapp\s*id\b|\bapplication\s*id\b/.test(x)]);
    const app = find([
      (x) => x === 'app' || x === 'app name' || x === 'application' || x === 'application name',
      (x) => /\bapp\b|application/.test(x) && !/\bid\b/.test(x),
    ]);
    const notRate = (x) => !/ecpm|rpm|cpm|cpc|ctr|rate|per |average|avg|%/.test(x);
    const revenue = find([
      (x) => x === 'revenue',
      (x) => /revenue/.test(x) && notRate(x),
      (x) => /earning|income|amount|sales/.test(x) && notRate(x),
    ]);
    return { date, app, appId, revenue };
  }

  // Identity of a whole row, used to drop rows that were exported twice.
  function rowSignature(row) {
    return row.map((c) => (typeof c === 'number' ? 'n' + String(c)
      : c instanceof Date ? 'd' + c.getTime() : JSON.stringify(c))).join('|');
  }

  function findHeaderRow(rows) {
    const limit = Math.min(rows.length, 15);
    for (let i = 0; i < limit; i++) {
      const row = rows[i] || [];
      if (row.some((c) => /\bdate\b|\bday\b/.test(norm(c)))) return i;
    }
    return -1;
  }

  /**
   * Turns a sheet (array of row arrays, header included) into clean records.
   * Supports long format (Date | App | Revenue ...) and wide format (Date | App A | App B ...).
   */
  function parseRows(rows, sheetName) {
    const report = {
      sheet: sheetName || '', format: null, rowsRead: 0, rowsUsed: 0,
      skippedNoDate: 0, skippedNoRevenue: 0, skippedNoApp: 0, exactDuplicates: 0, mergedDuplicates: 0,
      revenueColumn: null,
    };
    const headerIdx = findHeaderRow(rows);
    if (headerIdx === -1) return { records: [], report, ok: false };
    const header = rows[headerIdx].map((c) => (c === null || c === undefined ? '' : String(c).trim()));
    const cols = detectColumns(header);
    if (cols.date === -1) return { records: [], report, ok: false };

    const raw = []; // {date, app, revenue}
    const seenRows = new Set();
    const body = rows.slice(headerIdx + 1);

    const longFormat = cols.revenue !== -1 && (cols.app !== -1 || cols.appId !== -1);
    report.format = longFormat ? 'long' : 'wide';

    if (longFormat) {
      report.revenueColumn = header[cols.revenue];
      for (const row of body) {
        if (!row || row.every((c) => c === null || c === undefined || c === '')) continue;
        report.rowsRead++;
        const sig = rowSignature(row);
        if (seenRows.has(sig)) { report.exactDuplicates++; continue; }
        seenRows.add(sig);
        const date = parseDate(row[cols.date]);
        if (!date) { report.skippedNoDate++; continue; }
        const revenue = parseAmount(row[cols.revenue]);
        if (revenue === null) { report.skippedNoRevenue++; continue; }
        const name = cols.app !== -1 ? String(row[cols.app] ?? '').trim() : '';
        const id = cols.appId !== -1 ? String(row[cols.appId] ?? '').trim() : '';
        let app = name || (id ? `App ${id}` : '');
        if (!app) {
          // A row with no app and no revenue carries no information; a row with revenue must still count.
          if (revenue === 0) { report.skippedNoApp++; continue; }
          app = 'Unattributed';
        }
        raw.push({ date, app, revenue });
      }
    } else {
      const appCols = header
        .map((name, i) => ({ name, i }))
        .filter(({ name, i }) => i !== cols.date && name && !/^total|grand total|sum$/i.test(name));
      report.revenueColumn = '(one column per app)';
      for (const row of body) {
        if (!row || row.every((c) => c === null || c === undefined || c === '')) continue;
        report.rowsRead++;
        const sig = rowSignature(row);
        if (seenRows.has(sig)) { report.exactDuplicates++; continue; }
        seenRows.add(sig);
        const date = parseDate(row[cols.date]);
        if (!date) { report.skippedNoDate++; continue; }
        for (const { name, i } of appCols) {
          const revenue = parseAmount(row[i]);
          if (revenue === null) { report.skippedNoRevenue++; continue; }
          raw.push({ date, app: name, revenue });
        }
      }
    }

    // Merge rows that share a date and app (e.g. the same app split over several rows).
    const merged = new Map();
    for (const r of raw) {
      const k = `${r.date}\u0000${r.app}`;
      const cur = merged.get(k);
      if (cur) { cur.parts.push(r.revenue); report.mergedDuplicates++; }
      else merged.set(k, { date: r.date, app: r.app, parts: [r.revenue] });
    }
    const records = [...merged.values()].map((m) => ({ date: m.date, app: m.app, revenue: sum(m.parts) }));
    records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.app.localeCompare(b.app)));
    report.rowsUsed = raw.length;
    return { records, report, ok: records.length > 0 };
  }

  /** Picks the sheet that yields the most records from a SheetJS workbook. */
  function parseWorkbook(XLSX, workbook) {
    let best = null;
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      const parsed = parseRows(rows, name);
      if (parsed.ok && (!best || parsed.records.length > best.records.length)) best = parsed;
    }
    if (!best) throw new Error('No sheet with a Date column and revenue values was found.');
    return best;
  }

  // ---------- analytics ----------

  function dataBounds(records) {
    if (!records.length) return { min: null, max: null, years: [], months: [], apps: [] };
    let min = records[0].date, max = records[0].date;
    const years = new Set(), months = new Set(), appTotals = new Map();
    for (const r of records) {
      if (r.date < min) min = r.date;
      if (r.date > max) max = r.date;
      years.add(+r.date.slice(0, 4));
      months.add(+r.date.slice(5, 7));
      appTotals.set(r.app, (appTotals.get(r.app) || 0) + r.revenue);
    }
    const apps = [...appTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
    return { min, max, years: [...years].sort(), months: [...months].sort((a, b) => a - b), apps };
  }

  function applyFilters(records, f) {
    const appSet = f.apps ? new Set(f.apps) : null;
    return records.filter((r) =>
      (!f.from || r.date >= f.from) &&
      (!f.to || r.date <= f.to) &&
      (!f.year || +r.date.slice(0, 4) === +f.year) &&
      (!f.month || +r.date.slice(5, 7) === +f.month) &&
      (!appSet || appSet.has(r.app)));
  }

  function periodTotals(rows, ref) {
    const out = { today: 0, yesterday: 0, week: 0, month: 0 };
    if (!ref) return out;
    const y = addDays(ref, -1), ws = weekStart(ref), ms = ref.slice(0, 7) + '-01';
    const t = [], yy = [], w = [], m = [];
    for (const r of rows) {
      if (r.date === ref) t.push(r.revenue);
      if (r.date === y) yy.push(r.revenue);
      if (r.date >= ws && r.date <= ref) w.push(r.revenue);
      if (r.date >= ms && r.date <= ref) m.push(r.revenue);
    }
    return { today: sum(t), yesterday: sum(yy), week: sum(w), month: sum(m) };
  }

  function statsForRows(rows, ref) {
    const byDate = new Map();
    for (const r of rows) byDate.set(r.date, (byDate.get(r.date) || 0) + r.revenue);
    const days = [...byDate.entries()].map(([date, revenue]) => ({ date, revenue })).sort((a, b) => (a.date < b.date ? -1 : 1));
    const active = days.filter((d) => d.revenue > 0);
    let best = null, worst = null;
    for (const d of active) {
      if (!best || d.revenue > best.revenue) best = d;
      if (!worst || d.revenue < worst.revenue) worst = d;
    }
    const total = sum(rows.map((r) => r.revenue));
    return {
      total,
      ...periodTotals(rows, ref),
      recordedDays: days.length,
      activeDays: active.length,
      avgDaily: safeDiv(total, active.length),
      best, worst, days,
    };
  }

  function monthlySeries(rows) {
    const map = new Map();
    for (const r of rows) {
      const k = r.date.slice(0, 7);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r.revenue);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, vals]) => ({ month, revenue: sum(vals) }));
  }

  /**
   * Computes the whole dashboard model.
   * @param records clean records from parseRows
   * @param filters {from, to, month, year, apps: string[]|null, todayMode: 'latest'|'calendar'}
   */
  function compute(records, filters) {
    const f = filters || {};
    const rows = applyFilters(records, f);
    const bounds = dataBounds(rows);
    const ref = f.todayMode === 'calendar' ? localTodayKey() : bounds.max;

    const overall = statsForRows(rows, ref);
    const appNames = bounds.apps; // sorted by revenue, highest first
    const byApp = new Map(appNames.map((a) => [a, []]));
    for (const r of rows) byApp.get(r.app).push(r);
    const apps = appNames.map((name) => ({ name, ...statsForRows(byApp.get(name), ref) }));

    // Day-wise matrix: one row per date, one column per app, plus the daily total.
    const dayMap = new Map();
    for (const r of rows) {
      if (!dayMap.has(r.date)) dayMap.set(r.date, new Map());
      const m = dayMap.get(r.date);
      m.set(r.app, (m.get(r.app) || 0) + r.revenue);
    }
    const daily = [...dayMap.entries()]
      .map(([date, m]) => ({ date, byApp: m, total: sum([...m.values()]) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      filters: f, ref, rows, bounds,
      kpis: {
        total: overall.total,
        today: overall.today,
        yesterday: overall.yesterday,
        week: overall.week,
        month: overall.month,
        avgDaily: overall.avgDaily,
        totalApps: appNames.length,
        activeDays: overall.activeDays,
        recordedDays: overall.recordedDays,
      },
      overall, apps, daily,
      monthly: monthlySeries(rows),
    };
  }

  return {
    MONTHS, parseDate, parseAmount, detectColumns, parseRows, parseWorkbook,
    dataBounds, applyFilters, compute, statsForRows, monthlySeries,
    addDays, weekStart, dateFromKey, localTodayKey, sum, safeDiv,
  };
});
