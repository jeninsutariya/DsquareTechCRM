/* global XLSX, Chart, RevenueAnalytics */
(function () {
  'use strict';
  const RA = RevenueAnalytics;
  const DEFAULT_FILE = 'data/revenue.xlsx';
  const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  const state = {
    records: [], report: null, fileName: '',
    filters: { from: '', to: '', month: '', year: '', apps: null, todayMode: 'latest' },
    sort: { key: 'total', dir: -1 },
    detailApp: '',
    currency: store.get('rev.currency') || 'USD',
    colorSlot: new Map(), // app -> css var, fixed by overall rank so colors never shift with filters
    charts: {},
  };

  // ---------- formatting ----------

  let moneyFmt, compactFmt;
  function setCurrency(code) {
    const locale = code === 'INR' ? 'en-IN' : 'en-US';
    moneyFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    compactFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1 });
  }
  const clean = (n) => (Number.isFinite(n) ? n : 0);
  const money = (n) => moneyFmt.format(Math.abs(clean(n)) < 0.005 ? 0 : clean(n));
  const moneyCompact = (n) => compactFmt.format(clean(n));
  const intFmt = new Intl.NumberFormat('en-US');
  const pct = (n) => `${(clean(n) * 100).toFixed(1)}%`;
  function fmtDate(key, opts) {
    if (!key) return '—';
    return RA.dateFromKey(key).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }, opts));
  }
  const shortDate = (key) => fmtDate(key, { year: undefined });
  const monthLabel = (ym) => fmtDate(ym + '-01', { day: undefined, month: 'long' });

  function deltaPill(cur, prev) {
    if (!(prev > 0)) return cur > 0 ? '<span class="delta flat">no prior-day revenue</span>' : '';
    const change = (cur - prev) / prev;
    const cls = Math.abs(change) < 0.0005 ? 'flat' : change > 0 ? 'up' : 'down';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
    return `<span class="delta ${cls}" title="Change vs previous day">${arrow} ${Math.abs(change * 100).toFixed(1)}%</span>`;
  }

  // ---------- theme tokens ----------

  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const appColor = (app) => token(state.colorSlot.get(app) || '--other');

  // ---------- loading ----------

  function setLoadError(msg) {
    $('dashboard').hidden = true;
    $('emptyState').hidden = false;
    $('loadError').hidden = !msg;
    $('loadError').textContent = msg || '';
    $('sourceMeta').textContent = 'No data loaded';
  }

  function ingest(buffer, fileName) {
    let parsed;
    try {
      const wb = XLSX.read(buffer, { type: 'array', raw: false, cellDates: false });
      parsed = RA.parseWorkbook(XLSX, wb);
    } catch (err) {
      setLoadError(`Could not read “${fileName}”: ${err.message} Check that the sheet has a Date column and a revenue column.`);
      return;
    }
    state.records = parsed.records;
    state.report = parsed.report;
    state.fileName = fileName;
    const bounds = RA.dataBounds(state.records);
    state.colorSlot = new Map(bounds.apps.map((a, i) => [a, SLOTS[i] || '--other']));
    state.filters = { from: '', to: '', month: '', year: '', apps: null, todayMode: $('todayMode').value || 'latest' };
    state.detailApp = bounds.apps[0] || '';
    buildFilterOptions(bounds);
    $('emptyState').hidden = true;
    $('dashboard').hidden = false;
    render();
  }

  async function loadDefault() {
    try {
      const res = await fetch(DEFAULT_FILE, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.statusText);
      ingest(await res.arrayBuffer(), DEFAULT_FILE.split('/').pop());
    } catch (e) {
      setLoadError('');
    }
  }

  function loadFile(file) {
    if (!file) return;
    file.arrayBuffer().then((buf) => ingest(buf, file.name), (err) => setLoadError(`Could not open the file: ${err.message}`));
  }

  // ---------- filters ----------

  function buildFilterOptions(bounds) {
    for (const id of ['fromDate', 'toDate']) { $(id).min = bounds.min || ''; $(id).max = bounds.max || ''; }
    setDateInputs();
    $('monthSel').innerHTML = '<option value="">All months</option>' +
      bounds.months.map((m) => `<option value="${m}">${new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}</option>`).join('');
    $('yearSel').innerHTML = '<option value="">All years</option>' + bounds.years.map((y) => `<option value="${y}">${y}</option>`).join('');
    $('appList').innerHTML = bounds.apps.map((a, i) => `
      <label for="app-${i}"><input type="checkbox" id="app-${i}" value="${esc(a)}" checked>
        <span class="swatch" style="background:var(${state.colorSlot.get(a)})"></span><span>${esc(a)}</span></label>`).join('');
    $('detailApp').innerHTML = bounds.apps.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    updateAppSummary();
  }

  // Empty inputs look half-filled in some browsers, so show the full data range when no range is set.
  function setDateInputs() {
    $('fromDate').value = state.filters.from || $('fromDate').min;
    $('toDate').value = state.filters.to || $('toDate').max;
  }

  function readApps() {
    const boxes = [...$('appList').querySelectorAll('input')];
    const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
    state.filters.apps = chosen.length === boxes.length ? null : chosen;
    if (chosen.length && !chosen.includes(state.detailApp)) state.detailApp = chosen[0];
    updateAppSummary();
  }

  function updateAppSummary() {
    const apps = state.filters.apps;
    $('appSummary').textContent = !apps ? 'All apps' : apps.length === 0 ? 'No apps selected'
      : apps.length === 1 ? apps[0] : `${apps.length} apps selected`;
  }

  function readDates() {
    let from = $('fromDate').value || $('fromDate').min, to = $('toDate').value || $('toDate').max;
    if (from && to && from > to) { [from, to] = [to, from]; $('fromDate').value = from; $('toDate').value = to; }
    // A range equal to the full data span is no filter at all.
    state.filters.from = from === $('fromDate').min ? '' : from;
    state.filters.to = to === $('toDate').max ? '' : to;
  }

  function wireFilters() {
    $('fromDate').addEventListener('change', () => { readDates(); render(); });
    $('toDate').addEventListener('change', () => { readDates(); render(); });
    $('monthSel').addEventListener('change', (e) => { state.filters.month = e.target.value; render(); });
    $('yearSel').addEventListener('change', (e) => { state.filters.year = e.target.value; render(); });
    $('todayMode').addEventListener('change', (e) => { state.filters.todayMode = e.target.value; render(); });
    $('appList').addEventListener('change', () => { readApps(); render(); });
    $('appsAll').addEventListener('click', () => { $('appList').querySelectorAll('input').forEach((b) => { b.checked = true; }); readApps(); render(); });
    $('appsNone').addEventListener('click', () => { $('appList').querySelectorAll('input').forEach((b) => { b.checked = false; }); readApps(); render(); });
    document.addEventListener('click', (e) => { if (!$('appPicker').contains(e.target)) $('appPicker').open = false; });
    $('resetFilters').addEventListener('click', () => {
      $('monthSel').value = ''; $('yearSel').value = '';
      $('appList').querySelectorAll('input').forEach((b) => { b.checked = true; });
      Object.assign(state.filters, { from: '', to: '', month: '', year: '', apps: null });
      setDateInputs();
      updateAppSummary();
      render();
    });
    $('currency').value = state.currency;
    $('currency').addEventListener('change', (e) => { state.currency = e.target.value; store.set('rev.currency', state.currency); setCurrency(state.currency); render(); });
    $('detailApp').addEventListener('change', (e) => { state.detailApp = e.target.value; renderDetail(); });
    $('fileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });

    // Drag and drop anywhere on the page.
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; $('dropHint').hidden = false; } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('dropHint').hidden = true; });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; $('dropHint').hidden = true; loadFile(e.dataTransfer.files[0]); });

    document.querySelectorAll('#appTable thead th[data-key]').forEach((th) => {
      th.tabIndex = 0;
      const sortBy = () => {
        const key = th.dataset.key;
        state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
        renderAppTable();
      };
      th.addEventListener('click', sortBy);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } });
    });
  }

  // ---------- render ----------

  let model, modelAllApps;

  function render() {
    if (!state.records.length) return;
    model = RA.compute(state.records, state.filters);
    modelAllApps = RA.compute(state.records, Object.assign({}, state.filters, { apps: null }));
    renderMeta();
    renderKpis();
    renderCharts();
    renderAppTable();
    renderDetail();
    renderDayTable();
    renderNotes();
  }

  function renderMeta() {
    const all = RA.dataBounds(state.records);
    $('sourceMeta').innerHTML = `Source: <b>${esc(state.fileName)}</b> · ${intFmt.format(state.records.length)} app-day records · ${fmtDate(all.min)} – ${fmtDate(all.max)}`;
    const b = model.bounds;
    const f = state.filters;
    const bits = [];
    if (f.from || f.to) bits.push(`${f.from ? fmtDate(f.from) : 'start'} – ${f.to ? fmtDate(f.to) : 'end'}`);
    if (f.month) bits.push(new Date(Date.UTC(2000, f.month - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }));
    if (f.year) bits.push(f.year);
    const apps = f.apps ? (f.apps.length ? `${f.apps.length} of ${all.apps.length} apps` : 'no apps') : `all ${all.apps.length} apps`;
    $('scopeLine').innerHTML = b.min
      ? `Showing <b>${apps}</b>${bits.length ? ` · filtered to <b>${esc(bits.join(' · '))}</b>` : ''} · data from <b>${fmtDate(b.min)}</b> to <b>${fmtDate(b.max)}</b> · “today” is <b>${fmtDate(model.ref, { weekday: 'short' })}</b>`
      : 'No revenue matches these filters. Widen the date range or select more apps.';
  }

  function renderKpis() {
    const k = model.kpis, ref = model.ref;
    const set = (id, v, sub) => { $(id).textContent = v; $(id + 'Sub').innerHTML = sub; };
    set('kTotal', money(k.total), model.bounds.min ? `${fmtDate(model.bounds.min)} – ${fmtDate(model.bounds.max)}` : 'No data in range');
    set('kToday', money(k.today), ref ? `${fmtDate(ref, { weekday: 'short', year: undefined })} ${deltaPill(k.today, k.yesterday)}` : '—');
    set('kYesterday', money(k.yesterday), ref ? fmtDate(RA.addDays(ref, -1), { weekday: 'short', year: undefined }) : '—');
    const ws = ref ? RA.weekStart(ref) : null;
    set('kWeek', money(k.week), ref ? (ws === ref ? `Week starting ${shortDate(ws)} (day 1)` : `${shortDate(ws)} – ${shortDate(ref)}`) : '—');
    set('kMonth', money(k.month), ref ? `${monthLabel(ref.slice(0, 7))}, through ${shortDate(ref)}` : '—');
    set('kAvg', money(k.avgDaily), `Total ÷ ${intFmt.format(k.activeDays)} active day${k.activeDays === 1 ? '' : 's'}`);
    const earning = model.apps.filter((a) => a.total > 0).length;
    set('kApps', intFmt.format(k.totalApps), k.totalApps ? `${earning} with revenue in range` : 'No apps in range');
    set('kDays', intFmt.format(k.activeDays), `Days with revenue, of ${intFmt.format(k.recordedDays)} reported`);
  }

  // ---------- charts ----------

  function baseOptions(extra) {
    const ink2 = token('--ink-2'), grid = token('--grid'), axis = token('--axis');
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, labels: { color: ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 12 } },
        tooltip: {
          backgroundColor: token('--surface'), titleColor: token('--ink'), bodyColor: ink2,
          borderColor: token('--line-strong'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${c.parsed.y === null && c.parsed.x === null ? '—' : money(c.chart.options.indexAxis === 'y' ? c.parsed.x : c.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: token('--line-strong') }, ticks: { color: axis, maxRotation: 0, autoSkipPadding: 12 } },
        y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: axis, callback: (v) => moneyCompact(v), maxTicksLimit: 6 } },
      },
    }, extra || {});
  }

  function draw(id, config) {
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new Chart($(id), config);
  }

  function movingAverage(daily) {
    if (!daily.length) return [];
    const first = daily[0].date;
    const byDate = new Map(daily.map((d) => [d.date, d.total]));
    return daily.map((d) => {
      let s = 0, n = 0;
      for (let i = 0; i < 7; i++) {
        const k = RA.addDays(d.date, -i);
        if (k < first) break;
        s += byDate.get(k) || 0; n++;
      }
      return RA.safeDiv(s, n);
    });
  }

  function renderCharts() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    const daily = model.daily;
    const labels = daily.map((d) => shortDate(d.date));
    const s1 = token('--s1'), s2 = token('--s2');

    // 1. Total revenue by day
    draw('cDaily', {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Total', data: daily.map((d) => d.total), backgroundColor: s1, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 28 }] },
      options: baseOptions(),
    });

    // 2. Revenue by app (horizontal, largest first)
    const apps = model.apps;
    $('cByAppWrap').style.height = `${Math.max(240, apps.length * 34 + 40)}px`;
    draw('cByApp', {
      type: 'bar',
      data: { labels: apps.map((a) => a.name), datasets: [{ label: 'Revenue', data: apps.map((a) => a.total), backgroundColor: apps.map((a) => appColor(a.name)), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start', maxBarThickness: 22 }] },
      options: (() => {
        const o = baseOptions({ indexAxis: 'y' });
        o.interaction = { mode: 'nearest', axis: 'y', intersect: false };
        o.scales = {
          x: { beginAtZero: true, grid: { color: token('--grid') }, border: { display: false }, ticks: { color: token('--axis'), callback: (v) => moneyCompact(v), maxTicksLimit: 5 } },
          y: { grid: { display: false }, border: { color: token('--line-strong') }, ticks: { color: token('--ink-2'), callback(v) { const l = this.getLabelForValue(v); return l.length > 24 ? l.slice(0, 23) + '…' : l; } } },
        };
        return o;
      })(),
    });

    // 3. Daily trend with 7-day moving average
    draw('cTrend', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Daily total', data: daily.map((d) => d.total), borderColor: s1, backgroundColor: s1 + '22', fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25 },
          { label: '7-day average', data: movingAverage(daily), borderColor: s2, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false },
        ],
      },
      options: (() => { const o = baseOptions(); o.plugins.legend.display = true; o.plugins.legend.position = 'top'; o.plugins.legend.align = 'end'; return o; })(),
    });

    // 4. Monthly trend
    draw('cMonthly', {
      type: 'bar',
      data: { labels: model.monthly.map((m) => fmtDate(m.month + '-01', { day: undefined })), datasets: [{ label: 'Revenue', data: model.monthly.map((m) => m.revenue), backgroundColor: s1, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 56 }] },
      options: baseOptions(),
    });

    // 5. App comparison: one line per colored app; apps past the palette fold into "Other apps"
    const colored = apps.filter((a) => state.colorSlot.get(a.name) !== '--other');
    const rest = apps.filter((a) => state.colorSlot.get(a.name) === '--other');
    const series = colored.map((a) => ({
      label: a.name, color: appColor(a.name),
      data: daily.map((d) => (d.byApp.has(a.name) ? d.byApp.get(a.name) : null)),
    }));
    if (rest.length) {
      series.push({
        label: rest.length === 1 ? rest[0].name : `Other apps (${rest.length})`, color: token('--other'),
        data: daily.map((d) => { const v = rest.filter((a) => d.byApp.has(a.name)); return v.length ? RA.sum(v.map((a) => d.byApp.get(a.name))) : null; }),
      });
    }
    draw('cCompare', {
      type: 'line',
      data: { labels, datasets: series.map((s) => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.2, spanGaps: false })) },
      options: (() => {
        const o = baseOptions();
        o.plugins.legend.display = true; o.plugins.legend.position = 'bottom';
        o.plugins.tooltip.itemSort = (a, b) => (b.parsed.y || 0) - (a.parsed.y || 0);
        o.plugins.tooltip.filter = (c) => c.parsed.y !== null;
        return o;
      })(),
    });
  }

  // ---------- app table ----------

  function sortValue(a, key) {
    if (key === 'name') return a.name.toLowerCase();
    if (key === 'best' || key === 'worst') return a[key] ? a[key].revenue : -Infinity;
    return a[key];
  }

  function dayCell(d) {
    return d ? `${money(d.revenue)}<span class="small">${shortDate(d.date)}</span>` : '<span class="dim">—</span>';
  }

  function renderAppTable() {
    const { key, dir } = state.sort;
    const rows = model.apps.slice().sort((a, b) => {
      const va = sortValue(a, key), vb = sortValue(b, key);
      if (va < vb) return -dir; if (va > vb) return dir;
      return a.name.localeCompare(b.name);
    });
    document.querySelectorAll('#appTable thead th[data-key]').forEach((th) => {
      const on = th.dataset.key === key;
      th.setAttribute('aria-sort', on ? (dir > 0 ? 'ascending' : 'descending') : 'none');
      th.innerHTML = th.textContent.replace(/[▲▼]/g, '').trim() + `<span class="arrow">${on ? (dir > 0 ? '▲' : '▼') : ''}</span>`;
    });
    const tbody = $('appTable').querySelector('tbody');
    tbody.innerHTML = rows.length ? rows.map((a) => `
      <tr data-app="${esc(a.name)}" class="${a.name === state.detailApp ? 'selected' : ''}">
        <td class="txt"><span class="app-cell"><span class="swatch" style="background:${appColor(a.name)}"></span><button type="button">${esc(a.name)}</button></span></td>
        <td class="strong">${money(a.total)}</td>
        <td>${money(a.today)}</td>
        <td>${money(a.yesterday)}</td>
        <td>${money(a.week)}</td>
        <td>${money(a.month)}</td>
        <td>${money(a.avgDaily)}</td>
        <td>${dayCell(a.best)}</td>
        <td>${dayCell(a.worst)}</td>
        <td>${a.activeDays}<span class="small">of ${a.recordedDays} reported</span></td>
      </tr>`).join('') : '<tr><td class="txt dim" colspan="10">No apps match the current filters.</td></tr>';
    const o = model.overall;
    $('appTable').querySelector('tfoot').innerHTML = rows.length ? `<tr>
      <td class="txt">All apps shown</td><td>${money(o.total)}</td><td>${money(o.today)}</td><td>${money(o.yesterday)}</td>
      <td>${money(o.week)}</td><td>${money(o.month)}</td><td>${money(o.avgDaily)}</td>
      <td>${dayCell(o.best)}</td><td>${dayCell(o.worst)}</td><td>${o.activeDays}</td></tr>` : '';
    tbody.querySelectorAll('tr[data-app]').forEach((tr) => tr.addEventListener('click', () => {
      state.detailApp = tr.dataset.app;
      renderDetail();
      renderAppTable();
      $('appDetail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }));
  }

  // ---------- app detail ----------

  function renderDetail() {
    const name = state.detailApp;
    $('detailApp').value = name;
    // Period figures use the portfolio's "today" so the detail agrees with the app table.
    const ref = modelAllApps.ref;
    const a = RA.statsForRows(RA.applyFilters(state.records, Object.assign({}, state.filters, { apps: [name] })), ref);
    $('detailTitle').textContent = name || '—';
    $('dTotal').textContent = money(a.total);
    $('dAvg').innerHTML = `${money(a.avgDaily)}<small>over ${a.activeDays} active day${a.activeDays === 1 ? '' : 's'}</small>`;
    $('dToday').innerHTML = `${money(a.today)}<small>${ref ? fmtDate(ref, { year: undefined }) : '—'}</small>`;
    $('dBest').innerHTML = a.best ? `${money(a.best.revenue)}<small>${fmtDate(a.best.date)}</small>` : '—';
    $('dWorst').innerHTML = a.worst ? `${money(a.worst.revenue)}<small>${fmtDate(a.worst.date)}</small>` : '—';
    $('dShare').innerHTML = `${pct(RA.safeDiv(a.total, modelAllApps.kpis.total))}<small>of ${money(modelAllApps.kpis.total)} from all apps</small>`;

    const color = appColor(name);
    draw('cDetail', {
      type: 'line',
      data: { labels: a.days.map((d) => shortDate(d.date)), datasets: [{ label: name, data: a.days.map((d) => d.revenue), borderColor: color, backgroundColor: color + '26', fill: true, borderWidth: 2, pointRadius: a.days.length > 40 ? 0 : 2.5, pointHoverRadius: 5, tension: 0.25 }] },
      options: baseOptions(),
    });

    const byMonth = new Map();
    for (const d of a.days) {
      const k = d.date.slice(0, 7);
      const cur = byMonth.get(k) || { vals: [], active: 0 };
      cur.vals.push(d.revenue); if (d.revenue > 0) cur.active++;
      byMonth.set(k, cur);
    }
    $('detailMonthly').querySelector('tbody').innerHTML = byMonth.size
      ? [...byMonth.entries()].sort((x, y) => (x[0] < y[0] ? 1 : -1)).map(([k, v]) => `<tr><td class="txt">${monthLabel(k)}</td><td class="strong">${money(RA.sum(v.vals))}</td><td>${v.active}</td></tr>`).join('')
      : '<tr><td class="txt dim" colspan="3">No revenue in this period.</td></tr>';

    const dayTotals = new Map(modelAllApps.daily.map((d) => [d.date, d.total]));
    const hist = a.days.slice().reverse();
    $('detailHistory').querySelector('tbody').innerHTML = hist.length ? hist.map((d, i) => {
      const prev = hist[i + 1];
      let change = '<span class="dim">—</span>';
      if (prev) {
        const diff = d.revenue - prev.revenue;
        const cls = Math.abs(diff) < 0.005 ? 'flat' : diff > 0 ? 'up' : 'down';
        change = `<span class="delta ${cls}">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${money(Math.abs(diff))}</span>`;
      }
      return `<tr><td class="txt">${fmtDate(d.date, { weekday: 'short' })}</td><td class="strong">${money(d.revenue)}</td><td>${change}</td><td>${pct(RA.safeDiv(d.revenue, dayTotals.get(d.date)))}</td></tr>`;
    }).join('') : '<tr><td class="txt dim" colspan="4">No revenue in this period.</td></tr>';
  }

  // ---------- day-wise table ----------

  function renderDayTable() {
    const apps = model.apps;
    const table = $('dayTable');
    table.querySelector('thead').innerHTML = `<tr><th class="txt">Date</th>${apps.map((a) => `<th title="${esc(a.name)}">${esc(a.name)}</th>`).join('')}<th class="total-col">Total daily revenue</th></tr>`;
    const rows = model.daily.slice().reverse();
    table.querySelector('tbody').innerHTML = rows.length ? rows.map((d) => `<tr><td class="txt">${fmtDate(d.date, { weekday: 'short' })}</td>${apps.map((a) =>
      (d.byApp.has(a.name) ? `<td>${money(d.byApp.get(a.name))}</td>` : '<td class="dim" title="No data for this app on this date">—</td>')).join('')}<td class="total-col">${money(d.total)}</td></tr>`).join('')
      : `<tr><td class="txt dim" colspan="${apps.length + 2}">No revenue matches these filters.</td></tr>`;
    table.querySelector('tfoot').innerHTML = rows.length ? `<tr><td class="txt">Total (${rows.length} days)</td>${apps.map((a) => `<td>${money(a.total)}</td>`).join('')}<td class="total-col">${money(model.kpis.total)}</td></tr>` : '';
  }

  // ---------- notes ----------

  function renderNotes() {
    const r = state.report;
    const skipped = [];
    if (r.skippedNoDate) skipped.push(`${r.skippedNoDate} without a valid date (such as a “Total” row)`);
    if (r.skippedNoRevenue) skipped.push(`${r.skippedNoRevenue} empty or non-numeric revenue cell${r.skippedNoRevenue === 1 ? '' : 's'}`);
    if (r.skippedNoApp) skipped.push(`${r.skippedNoApp} with no app name and zero revenue`);
    if (r.exactDuplicates) skipped.push(`${r.exactDuplicates} exact duplicate row${r.exactDuplicates === 1 ? '' : 's'}`);
    $('notes').innerHTML = `
      <p><b>Data.</b> Sheet “${esc(r.sheet)}”, revenue column “${esc(r.revenueColumn)}”. ${intFmt.format(r.rowsRead)} rows read, ${intFmt.format(r.rowsUsed)} used.
      ${skipped.length ? `Ignored: ${esc(skipped.join('; '))}.` : 'No rows were ignored.'}
      ${r.mergedDuplicates ? `${r.mergedDuplicates} repeated app/date row${r.mergedDuplicates === 1 ? ' was' : 's were'} added into one daily figure.` : ''}</p>
      <p><b>How figures are calculated.</b> Overall total = sum of every app on every date in the filters. Daily total = sum of all apps on that date. App total = sum of that app across all dates.
      “Today” is the ${state.filters.todayMode === 'calendar' ? 'calendar date on this device' : 'latest date in the filtered data'}; the week runs Monday to “today” and the month runs from the 1st to “today”.
      An active day is a day with revenue above zero; average daily revenue = total ÷ active days. Highest and lowest days are taken from active days. Amounts are shown in ${esc(state.currency)} exactly as reported, with no conversion.</p>`;
  }

  // ---------- boot ----------

  setCurrency(state.currency);
  wireFilters();
  const rerenderCharts = () => { if (model) { renderCharts(); renderDetail(); renderAppTable(); } };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts); } catch (e) { /* old browsers */ }
  new MutationObserver(rerenderCharts).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  loadDefault();
})();
