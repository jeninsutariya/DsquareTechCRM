const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');
const RA = require('../dashboard/analytics.js');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

function loadSample() {
  const wb = XLSX.readFile(path.join(__dirname, '../dashboard/data/revenue.xlsx'));
  return RA.parseWorkbook(XLSX, wb);
}

test('sample workbook: totals match an independent row sum and skip the Total row', () => {
  const { records, report } = loadSample();
  const wb = XLSX.readFile(path.join(__dirname, '../dashboard/data/revenue.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const header = rows[0];
  const revCol = header.indexOf('Ad Exchange revenue');
  const expected = rows.slice(1).filter((r) => typeof r[0] === 'number').reduce((s, r) => s + r[revCol], 0);
  const model = RA.compute(records, {});

  assert.equal(report.revenueColumn, 'Ad Exchange revenue');
  close(model.kpis.total, expected, 'overall total');
  close(model.kpis.total, 3299.428728811335, 'matches the sheet footer');
  close(RA.sum(model.apps.map((a) => a.total)), model.kpis.total, 'app totals add up');
  close(RA.sum(model.daily.map((d) => d.total)), model.kpis.total, 'daily totals add up');
  assert.equal(model.kpis.totalApps, 9);
  assert.equal(model.ref, '2026-08-31');
  assert.equal(model.daily.length, 31);
  for (const d of model.daily) close(d.total, RA.sum([...d.byApp.values()]), `daily ${d.date}`);
});

test('period KPIs follow the reference date', () => {
  const { records } = loadSample();
  const m = RA.compute(records, {});
  const byDay = new Map(m.daily.map((d) => [d.date, d.total]));
  close(m.kpis.today, byDay.get('2026-08-31'), 'today');
  close(m.kpis.yesterday, byDay.get('2026-08-30'), 'yesterday');
  // 2026-08-31 is a Monday, so the week so far is that single day.
  close(m.kpis.week, byDay.get('2026-08-31'), 'week');
  close(m.kpis.month, m.kpis.total, 'month');
  close(m.kpis.avgDaily, m.kpis.total / m.kpis.activeDays, 'avg');
});

test('filters recalculate everything', () => {
  const { records } = loadSample();
  const m = RA.compute(records, { from: '2026-08-10', to: '2026-08-12', apps: ['All Video Lite'] });
  assert.equal(m.apps.length, 1);
  assert.equal(m.daily.length, 3);
  assert.equal(m.ref, '2026-08-12');
  close(m.kpis.total, RA.sum(m.daily.map((d) => d.total)), 'filtered total');
  const none = RA.compute(records, { year: 2020 });
  assert.equal(none.kpis.total, 0);
  assert.equal(none.kpis.avgDaily, 0);
  assert.equal(none.ref, null);
});

test('missing values, blanks, junk and duplicates never produce NaN or double counts', () => {
  const rows = [
    ['Report'],
    ['Date', 'App', 'Revenue'],
    ['2026-01-01', 'A', 10],
    ['2026-01-01', 'A', 10],          // exact duplicate row: dropped
    ['2026-01-01', 'A', '$5.50'],     // same date/app, different row: merged
    ['2026-01-02', 'A', null],        // empty cell
    ['2026-01-02', 'B', 'n/a'],
    ['2026-01-02', 'B', '1,234.50'],
    ['2026-01-03', 'B', NaN],
    ['2026-01-03', 'B', Infinity],
    ['not a date', 'B', 99],
    ['2026-01-03', '', 0],            // no app and no revenue: ignored
    ['2026-01-03', '', 2],            // no app but revenue: kept
    [null, null, null],
  ];
  const { records, report } = RA.parseRows(rows, 't');
  assert.equal(report.exactDuplicates, 1);
  assert.equal(report.mergedDuplicates, 1);
  const m = RA.compute(records, {});
  close(m.kpis.total, 10 + 5.5 + 1234.5 + 2, 'total');
  for (const v of Object.values(m.kpis)) assert.ok(Number.isFinite(v));
  assert.deepEqual(m.apps.map((a) => a.name), ['B', 'A', 'Unattributed']);
});

test('wide format (Date | App A | App B | Total) is supported', () => {
  const rows = [
    ['Date', 'App A', 'App B', 'Total'],
    [46023, 1, 2, 3],
    [46024, '', 4, 4],
  ];
  const { records } = RA.parseRows(rows);
  const m = RA.compute(records, {});
  close(m.kpis.total, 7, 'total excludes Total column');
  assert.equal(m.daily[0].date, '2026-01-01');
});

test('date parsing', () => {
  assert.equal(RA.parseDate(46235), '2026-08-01');
  assert.equal(RA.parseDate('Aug 1, 2026'), '2026-08-01');
  assert.equal(RA.parseDate('01/08/2026'), '2026-08-01');
  assert.equal(RA.parseDate('13/31/2026'), null);
  assert.equal(RA.parseDate('2026-08-31'), '2026-08-31');
  assert.equal(RA.parseDate('Total'), null);
  assert.equal(RA.parseDate('2026-02-30'), null);
});
