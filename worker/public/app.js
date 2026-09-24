// Visto dashboard. Vanilla ES module, hand-drawn SVG charts, no build step.

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOCALE = 'en-US';
const nf = new Intl.NumberFormat(LOCALE);
const nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 });
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtShort = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDateF = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat(LOCALE, { month: 'short', timeZone: 'UTC' });
const fmtMonthLong = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dayDate = d => new Date(`${d}T00:00:00Z`);
const fmtDate = d => fmtDateF.format(dayDate(d)); // "Nov 24, 2016"
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const addDays = (d, n) => { const x = dayDate(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const watchUrl = (id, short) => short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
const svgIcon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const FORMATS = [
  ['video', 'Videos', 'var(--s1)'],
  ['short', 'Shorts', 'var(--s2)'],
  ['music', 'YouTube Music', 'var(--s3)'],
  ['unknown', 'Unknown length', 'var(--s-rest)'],
];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function clock(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function hours(s) {
  const h = s / 3600;
  return h >= 10 ? `${nf.format(Math.round(h))} h` : h >= 1 ? `${nf1.format(h)} h` : `${nf.format(Math.round(s / 60))} min`;
}
function compact(n) {
  return n >= 10000 ? new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : nf.format(n);
}
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
// Stable per-channel avatar color, like YouTube's letter avatars.
const AVATAR = ['#c2185b', '#7b1fa2', '#512da8', '#1976d2', '#0097a7', '#388e3c', '#f57c00', '#5d4037', '#455a64', '#e64a19'];
function avatar(name) {
  let h = 0;
  for (const c of name || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letter = (name || '?').trim().replace(/^@/, '').charAt(0).toUpperCase() || '?';
  return `<span class="avatar" style="background:${AVATAR[h % AVATAR.length]}" aria-hidden="true">${esc(letter)}</span>`;
}

// ---------- state & routing ----------------------------------------------------

const state = { range: 'all', day: null, dayPinned: false, summary: null, theme: null, sel: null, metric: 'views',
                savesSort: { field: 'recent', dir: 'desc' }, subsSort: { field: 'recent', dir: 'desc' }, themesExpanded: false };
const themeQS = () => (state.theme ? `&theme=${encodeURIComponent(state.theme)}` : '');

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // r = 'all' or a year. Older links (r=30, r=365, y=2019) map onto that.
  const r = p.get('y') || p.get('r');
  state.range = /^\d{4}$/.test(r || '') ? r : 'all';
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('d') || '')) { state.day = p.get('d'); state.dayPinned = true; }
  if (/^[a-z]+$/.test(p.get('t') || '')) state.theme = p.get('t');
  if (p.get('m') === 'time') state.metric = 'time';
}
function writeHash() {
  const p = new URLSearchParams();
  p.set('r', state.range);
  if (state.day && state.dayPinned) p.set('d', state.day);
  if (state.theme) p.set('t', state.theme);
  if (state.metric === 'time') p.set('m', 'time');
  history.replaceState(null, '', `#${p}`);
}

async function api(path) {
  // Always ask the Worker: it caches for us, and a browser-cached answer would hide new data.
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-cache' });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------- tooltip --------------------------------------------------------------

const tip = $('#tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let left = x + 12, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 12;
  if (top < 8) top = y + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => tip.classList.remove('on');
function bindTips(root) {
  root.addEventListener('pointermove', e => {
    const t = e.target.closest('[data-tip]');
    if (t) showTip(t.dataset.tip, e.clientX, e.clientY); else hideTip();
  });
  root.addEventListener('pointerleave', hideTip);
  root.addEventListener('focusin', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    showTip(t.dataset.tip, r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', hideTip);
}

// ---------- figures --------------------------------------------------------------

function topThemeFig(s) {
  if (state.theme) return { k: 'Topic', icon: 'chart', v: esc(themeLabel(state.theme)), s: 'active filter · clear it above' };
  const dist = s.themes.dist.filter(r => r.id !== 'pending');
  const total = dist.reduce((a, r) => a + r.n, 0);
  if (!dist.length) return { k: 'Top topic', icon: 'chart', v: '—', s: 'not classified yet' };
  return { k: 'Top topic', icon: 'chart', v: esc(themeLabel(dist[0].id)),
           s: `${pct.format(dist[0].n / total)} of what you watched${dist[1] ? ` · then ${esc(themeLabel(dist[1].id))}` : ''}` };
}

// Only the panels the imported data can fill: someone who collects just their
// likes, or just history and Favorites, sees a dashboard made of exactly that.
function showPanels(s) {
  const m = s.meta, watched = !!m.first_day;
  const show = (sel, on) => { const el = document.querySelector(sel); if (el) el.hidden = !on; };
  const section = id => `section[aria-labelledby="${id}"]`;
  show('#figures', watched || m.n_likes);
  show(section('h-act'), watched);
  show(section('h-themes'), watched && m.has_themes);
  show(section('h-rep'), watched);
  show(section('h-ch'), watched);
  show(section('h-saves'), m.n_favorites);
  show(section('h-likes'), m.n_likes);
  show(section('h-subs'), m.n_subs);
  show(section('h-hours'), watched && m.has_timed);
  show(section('h-fmt'), watched);
}

function renderFigures(s) {
  const k = s.kpi;
  const perDay = k.active_days ? k.views / k.active_days : 0;
  let delta = '';
  let played = 0;
  if (state.range !== 'all' && k.prev_views) {
    const d = (k.views - k.prev_views) / k.prev_views;
    // The Worker compares a year with the same dates of the year before.
    const prevYear = Number(state.range) - 1;
    const vs = s.range.to.slice(5) === '12-31' ? prevYear : `the same dates of ${prevYear}`;
    delta = `<span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'} ${pct.format(Math.abs(d))}</span> vs. ${vs} (${nf.format(k.prev_views)})`;
    played = Math.min(100, (k.views / Math.max(k.views, k.prev_views)) * 100);
  } else if (state.range !== 'all') {
    delta = `no data for ${Number(state.range) - 1}`;
  } else {
    delta = s.meta.first_day ? `since ${fmtDate(s.meta.first_day)}` : '';
  }
  const coverage = k.views ? k.with_duration / k.views : 0;
  const figs = [
    { hero: true, k: 'Videos watched', v: compact(k.views), s: delta },
    { k: 'Estimated time', icon: 'clock', v: s.time.total_s ? `≈ ${hours(s.time.total_s)}` : '—',
      s: s.time.measured_s
        ? `${hours(s.time.measured_s)} measured in the browser, the rest from the gaps between videos`
        : `from the gap between one video and the next${s.time.untimed_n ? ` (${nf.format(s.time.untimed_n)} without a time: their length)` : ''}` },
    { k: 'Channels', icon: 'channel', v: compact(k.channels), s: `${plural(k.uniq, 'different video')}` },
    s.meta.n_likes ? { k: 'Likes', icon: 'like', v: compact(s.likes.in_range), s: `${nf.format(s.likes.watched_liked)} of the videos you watched have your like` } : null,
    s.meta.has_themes ? topThemeFig(s) : null,
    // A past year has no running streak: show its best one instead.
    s.range.to < s.range.today
      ? { k: 'Best streak', icon: 'history', v: plural(s.streak.longest, 'day'),
          s: `in a row in ${esc(state.range)} · ${nf1.format(perDay)} videos per active day` }
      : { k: 'Streak', icon: 'history', v: plural(s.streak.current, 'day'),
          s: `record${state.range === 'all' ? '' : ` in ${esc(state.range)}`}: ${s.streak.longest} · ${nf1.format(perDay)} videos per active day` },
  ];
  // Without watch history only the likes figure has something to say.
  const shown = figs.filter(Boolean).filter(f => s.meta.first_day || f.icon === 'like');
  $('#figures').innerHTML = shown.map(f => `
    <div class="fig${f.hero ? ' hero' : ''}"${f.hero ? ` style="--played:${played}%"` : ''}>
      <div class="k">${f.icon ? svgIcon(f.icon) : ''}${f.k}</div>
      <div class="v">${f.v}</div>
      <div class="s">${f.s}</div>
    </div>`).join('');
}

// ---------- activity (bars per week / month) ------------------------------------

function quantizer(values, steps = 5) {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b);
  if (!nz.length) return { level: () => 0, edges: [] };
  const edges = [];
  for (let i = 1; i < steps; i++) edges.push(nz[Math.min(nz.length - 1, Math.floor((nz.length * i) / steps))]);
  const level = v => (v <= 0 ? 0 : 1 + edges.filter(e => v > e).length);
  return { level, edges };
}

function bucketSeries(s) {
  const { from, to } = s.range;
  const days = Math.round((dayDate(to) - dayDate(from)) / 86400000) + 1;
  const byDay = new Map(s.series.map(r => [r.d, r]));
  const unit = days <= 120 ? 'day' : days <= 800 ? 'week' : 'month';
  const buckets = [];
  const keyOf = d => {
    if (unit === 'day') return d;
    if (unit === 'month') return d.slice(0, 7);
    const x = dayDate(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
  };
  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const k = keyOf(d);
    let b = map.get(k);
    if (!b) { b = { key: k, start: d, end: d, n: 0, shorts: 0, s: 0 }; map.set(k, b); buckets.push(b); }
    b.end = d;
    const r = byDay.get(d);
    if (r) { b.n += r.n; b.shorts += r.shorts || 0; b.s += r.s || 0; }
  }
  return { unit, buckets };
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}

const UNIT = {
  day: { one: 'day', many: 'days', col: 'Day' },
  week: { one: 'week', many: 'weeks', col: 'Week of' },
  month: { one: 'month', many: 'months', col: 'Month' },
};
function bucketLabel(unit, b) {
  if (unit === 'day') return fmtLong.format(dayDate(b.start));
  if (unit === 'week') return `Week of ${fmtDate(b.start)}`;
  return fmtMonthLong.format(dayDate(b.start));
}

// The two things the activity bars can count. Time is in hours and estimated (see
// GAP_EST in stats.js: measured in Brave when known, else the gap to the next view).
const METRICS = {
  views: { of: b => b.n, tick: v => nf.format(v), fmt: v => plural(Math.round(v), 'video'), avg: v => nf1.format(v),
           name: 'Videos' },
  time: { of: b => b.s / 3600, tick: v => `${nf.format(v)} h`, fmt: v => `≈ ${hours(v * 3600)}`, avg: v => hours(v * 3600),
          name: 'Estimated hours' },
};

// One bar per week (a year) or per month (Todo). Clicking a bar lists its videos below;
// clicking it again clears the selection. The switch picks videos or watch time.
function renderActivity(s) {
  const { unit, buckets } = bucketSeries(s);
  const u = UNIT[unit];
  const M = METRICS[state.metric];
  const el = $('#activity');
  const W = Math.max(320, el.clientWidth || 900), H = 220, padL = 42, padB = 22, padT = 8;
  const max = niceMax(Math.max(1, ...buckets.map(M.of)));
  const band = (W - padL) / buckets.length;
  const barW = Math.max(2, Math.min(24, band - 2)); // >= 2px surface gap between bars
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  const active = buckets.filter(b => b.n);
  const avg = active.length ? active.reduce((a, b) => a + M.of(b), 0) / active.length : 0;

  let g = [0, max / 2, max].map(t => `<line class="${t ? 'grid' : 'base'}" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="tick" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${M.tick(t)}</text>`).join('');
  // Month bars get a label per year (January), weeks one per month.
  let lastLab = null, lastX = -Infinity;
  buckets.forEach((b, i) => {
    const v = M.of(b);
    const x = padL + i * band + (band - barW) / 2;
    const top = y(v), h = H - padB - top;
    const when = bucketLabel(unit, b);
    // The tooltip always gives both numbers; the bar shows the chosen one.
    const tipHtml = `<b>${esc(when)}</b><br>${plural(b.n, 'video')}${b.shorts ? ` · ${plural(b.shorts, 'short')}` : ''}${b.s ? `<br>≈ ${hours(b.s)} watched` : ''}`;
    g += `<rect class="hit" x="${padL + i * band}" y="${padT}" width="${band}" height="${H - padT}" data-tip="${esc(tipHtml)}"
      data-from="${b.start}" data-to="${b.end}" data-unit="${unit}" data-label="${esc(when)}" tabindex="0" role="button" aria-label="${esc(`${when}: ${M.fmt(v)}`)}"/>`;
    if (v > 0 && h > 0) {
      const r = Math.min(4, barW / 2, h);
      g += `<path class="col" d="M${x},${H - padB} V${top + r} q0,-${r} ${r},-${r} H${x + barW - r} q${r},0 ${r},${r} V${H - padB} Z"/>`;
    } else g += '<g></g>'; // keeps "hit + .col" pairs aligned
    // One tick per year (month bars) or per month (week bars), never closer than 34px.
    const lab = unit === 'month' ? b.start.slice(0, 4) : b.start.slice(0, 7);
    const lx = padL + i * band;
    if (lab !== lastLab && lx - lastX >= 34) {
      g += `<text class="tick" x="${lx}" y="${H - 6}">${unit === 'month' ? lab : fmtMonth.format(dayDate(b.start))}</text>`;
      lastLab = lab; lastX = lx;
    }
  });
  if (avg) {
    g += `<line class="avg" x1="${padL}" x2="${W}" y1="${y(avg)}" y2="${y(avg)}"/>
      <text class="avg-label" x="${W}" y="${y(avg) - 5}" text-anchor="end">avg ${M.avg(avg)} per ${u.one}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" aria-label="${M.name} per ${u.one}">${g}</svg>`;
  $('#act-legend').innerHTML = `<span><i style="background:var(--bar)"></i>${M.name} per ${u.one} · click a bar to see its videos; click again to clear</span><span><i class="line" style="background:var(--ink)"></i>Average of active ${u.many}</span>`;
  document.querySelectorAll('#act-metric [data-metric]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.metric === state.metric)));

  // Caption and table describe the whole active period.
  const total = s.series.reduce((a, r) => a + r.n, 0);
  const days = s.series.length;
  $('#act-caption').textContent = state.metric === 'time'
    ? `≈ ${hours(s.time.total_s)} · ${plural(days, 'active day')} · avg ${days ? hours(s.time.total_s / days) : '0 min'} a day`
    : `${plural(total, 'video')} · ${plural(days, 'active day')} · avg ${nf1.format(days ? total / days : 0)} a day`;
  $('#act-table-summary').textContent = `Show data table (per ${u.one} · avg ${M.avg(avg)})`;
  $('#act-table').innerHTML = `<table><thead><tr><th>${u.col}</th><th>Videos</th><th>Shorts</th><th>Estimated time</th></tr></thead><tbody>${
    buckets.slice().reverse().filter(b => b.n).map(b => `<tr><td>${esc(unit === 'week' ? fmtDate(b.start) : bucketLabel(unit, b))}</td><td class="num">${nf.format(b.n)}</td><td class="num">${nf.format(b.shorts)}</td><td class="num">${b.s ? hours(b.s) : '—'}</td></tr>`).join('')}</tbody></table>`;
  markSelected();
}

// ---------- period chips (All time + one per year) --------------------------------------

function renderRanges(s) {
  const firstYear = Number((s.meta.first_day || s.range.today).slice(0, 4));
  const years = [];
  for (let y = Number(s.range.today.slice(0, 4)); y >= firstYear; y--) years.push(String(y));
  const bar = $('#ranges');
  bar.innerHTML = ['all', ...years].map(r =>
    `<button class="chip" data-range="${r}" aria-pressed="${state.range === r}">${r === 'all' ? 'All time' : r}</button>`).join('');
  // Phones scroll the row sideways: keep the active chip in view.
  const on = bar.querySelector('[aria-pressed="true"]');
  if (on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = on.offsetLeft - bar.offsetLeft - 16;
}

// ---------- side panels ----------------------------------------------------------

async function loadChannels(page) {
  const s = state.summary;
  const r = await api(`/api/channels?from=${s.range.from}&to=${s.range.to}&page=${page}${themeQS()}`);
  if (state.summary !== s) return; // the period changed meanwhile
  $('#channels-caption').textContent = r.total ? `${nf.format(r.total)} in this period` : '';
  if (!r.items.length) { $('#channels').innerHTML = '<li class="note" style="display:block">No channels yet.</li>'; $('#channels-pager').innerHTML = ''; return; }
  // Bars stay relative to the period's top channel on every page.
  if (!page) state.channelsMax = r.items[0].n;
  const max = state.channelsMax || r.items[0].n;
  $('#channels').innerHTML = r.items.map(c => {
    const href = c.channel_id ? `https://www.youtube.com/channel/${c.channel_id}` : null;
    const name = `<span class="name">${esc(c.channel)}</span>${href ? ` <a class="ext" href="${href}" target="_blank" rel="noopener" aria-label="Open channel on YouTube" title="Open on YouTube">↗</a>` : ''}`;
    return `<li class="pick" tabindex="0" role="button" data-channel="${esc(c.channel_id || c.channel)}" data-label="${esc(c.channel)}">${avatarImg(c.avatar, c.channel)}<div style="min-width:0">${name}
      <div class="sub">${plural(c.uniq, 'different video')}</div>
      <div class="bar"><i style="width:${Math.min(100, (c.n / max) * 100)}%"></i></div></div>
      <span class="n">${nf.format(c.n)}</span></li>`;
  }).join('');
  $('#channels-pager').innerHTML = pagerHtml(page, r.pages);
  markSelected();
}

const pagerHtml = (page, pages) => pages > 1
  ? `<button class="chip" data-page="${page - 1}" ${page ? '' : 'disabled'}>Previous</button><span class="note">${nf.format(page + 1)} / ${nf.format(pages)}</span><button class="chip" data-page="${page + 1}" ${page + 1 < pages ? '' : 'disabled'}>Next</button>`
  : '';

function renderHours(s) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of s.hourWeek) if (r.dow != null && r.hour != null) grid[r.dow][r.hour] = r.n;
  const total = s.hourWeek.reduce((a, r) => a + r.n, 0);
  const el = $('#hours');
  if (!total) {
    el.innerHTML = '';
    $('#hours-note').textContent = 'Shows up once there are timed views: from Google Takeout or from what you watch in the browser.';
    return;
  }
  const W = Math.max(280, el.clientWidth || 380), labelW = 16, gap = 2;
  const cell = (W - labelW) / 24 - gap;
  const step = cell + gap, H = 7 * step + 16;
  const q = quantizer(grid.flat());
  let g = '';
  grid.forEach((row, d) => {
    g += `<text x="0" y="${d * step + cell - 1}">${DOW[d]}</text>`;
    row.forEach((n, h) => {
      g += `<rect class="h" data-dow="${d}" data-hour="${h}" tabindex="-1" x="${labelW + h * step}" y="${d * step}" width="${cell}" height="${cell}" rx="2" fill="var(--q${q.level(n)})"
        data-tip="<b>${DOW_LONG[d]}, ${h}:00–${h + 1}:00</b><br>${plural(n, 'video')}"></rect>`;
    });
  });
  [0, 6, 12, 18, 23].forEach(h => { g += `<text x="${labelW + h * step}" y="${H - 2}">${h}h</text>`; });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-label="Videos by weekday and hour">${g}</svg>`;
  let best = [0, 0, 0];
  grid.forEach((row, d) => row.forEach((n, h) => { if (n > best[0]) best = [n, d, h]; }));
  $('#hours-note').textContent = `Your busiest slot: ${DOW_LONG[best[1]]} at ${best[2]}:00. Based on ${plural(total, 'video')} with a known time.`;
}

function renderFormats(s) {
  const counts = Object.fromEntries(s.formats.map(r => [r.f, r.n]));
  const total = s.formats.reduce((a, r) => a + r.n, 0);
  if (!total) { $('#formats').innerHTML = '<p class="note">No data yet.</p>'; return; }
  const rows = FORMATS.filter(([k]) => counts[k]);
  $('#formats').innerHTML = `
    <div class="stackbar" role="img" aria-label="Split by format">${rows.map(([k, label, color]) =>
      `<i style="flex:${counts[k]};background:${color}" data-tip="<b>${label}</b><br>${nf.format(counts[k])} · ${pct.format(counts[k] / total)}"></i>`).join('')}</div>
    <div class="stack-legend">${rows.map(([k, label, color]) =>
      `<i style="background:${color}"></i><span>${label}</span><span class="n">${nf.format(counts[k])}</span><span class="p">${pct.format(counts[k] / total)}</span>`).join('')}</div>`;
}


// ---------- themes ----------------------------------------------------------------

const themeLabel = id => state.themeList?.find(t => t.id === id)?.label || (id === 'pending' ? 'Not classified yet' : id);
// Colour follows the theme, never its rank in the current range: slots come from the
// all-time order (fixed validated palette, 8 slots) and the rest share a neutral.
function themeColor(id) {
  const i = (state.themeOrder || []).indexOf(id);
  return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--s-rest)';
}

function renderThemes(s) {
  const dist = s.themes.dist.filter(r => r.id !== 'pending');
  const total = dist.reduce((a, r) => a + r.n, 0);
  $('#themes-caption').textContent = state.theme ? `filtering: ${themeLabel(state.theme)}` : 'in this period';
  if (!total) { $('#theme-rank').innerHTML = '<li class="note" style="display:block">Not classified yet: topics arrive with the YouTube API metadata.</li>'; return; }
  const max = dist[0].n;
  // Only themes with at least 5 % of the period are listed; the long tail sits behind
  // "See all" so the ranking stays short and every visible row has its own colour.
  const major = dist.filter(r => Math.round((r.n / total) * 100) >= 5); // as displayed (rounded)
  const visible = major.length ? major : dist.slice(0, 1);
  const shown = state.themesExpanded ? dist : visible;
  const more = $('#theme-more');
  more.hidden = dist.length <= visible.length;
  more.textContent = state.themesExpanded ? 'See less' : `See all (${dist.length - visible.length} more)`;
  $('#theme-rank').innerHTML = shown.map(r => `
    <li class="pick" tabindex="0" role="button" data-theme="${r.id}" aria-pressed="${r.id === state.theme}">
      <span class="swatch" style="background:${themeColor(r.id)}"></span>
      <div style="min-width:0"><span class="name">${esc(themeLabel(r.id))}</span>
        <div class="bar"><i style="width:${(r.n / max) * 100}%;background:${themeColor(r.id)}"></i></div></div>
      <span class="n">${nf.format(r.n)} · ${pct.format(r.n / total)}</span></li>`).join('');
}

function renderThemeYears(t) {
  const el = $('#theme-years');
  const totals = new Map();
  for (const r of t.rows) if (r.id !== 'pending') totals.set(r.id, (totals.get(r.id) || 0) + r.n);
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([id]) => id);
  const years = [...new Set(t.rows.map(r => r.y))].sort();
  const by = new Map(years.map(y => [y, new Map()]));
  for (const r of t.rows) if (r.id !== 'pending') {
    const k = top.includes(r.id) ? r.id : 'rest';
    by.get(r.y).set(k, (by.get(r.y).get(k) || 0) + r.n);
  }
  const keys = [...top, 'rest'];
  const W = Math.max(320, el.clientWidth || 700), H = 200, padL = 34, padB = 22, padT = 6;
  const band = (W - padL) / years.length, barW = Math.min(28, band - 6);
  const yy = f => padT + (H - padT - padB) * (1 - f);
  let g = [0, 0.5, 1].map(f => `<line class="${f ? 'grid' : 'base'}" x1="${padL}" x2="${W}" y1="${yy(f)}" y2="${yy(f)}"/>
    <text class="tick" x="${padL - 6}" y="${yy(f) + 4}" text-anchor="end">${pct.format(f)}</text>`).join('');
  years.forEach((y, i) => {
    const m = by.get(y), sum = [...m.values()].reduce((a, b) => a + b, 0);
    if (!sum) return;
    const x = padL + i * band + (band - barW) / 2;
    let acc = 0;
    for (const k of keys) {
      const n = m.get(k) || 0;
      if (!n) continue;
      const y0 = yy(acc / sum), y1 = yy((acc + n) / sum);
      acc += n;
      const h = Math.max(0, y0 - y1 - 2); // 2px surface gap between segments
      const color = k === 'rest' ? 'var(--s-rest)' : themeColor(k);
      const label = k === 'rest' ? 'Rest' : themeLabel(k);
      g += `<rect class="seg" data-theme="${k}" data-year="${y}" x="${x}" y="${y1 + 1}" width="${barW}" height="${h}" fill="${color}" data-tip="<b>${y} · ${esc(label)}</b><br>${plural(n, 'video')} · ${pct.format(n / sum)}"/>`;
    }
    g += `<text class="tick" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${y}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" aria-label="Topics by year">${g}</svg>`;
  $('#theme-years-legend').innerHTML = keys.map(k => `<span><i style="background:${k === 'rest' ? 'var(--s-rest)' : themeColor(k)}"></i>${esc(k === 'rest' ? 'Rest' : themeLabel(k))}</span>`).join('');
  $('#theme-years-table').innerHTML = `<table><thead><tr><th>Year</th>${keys.map(k => `<th>${esc(k === 'rest' ? 'Rest' : themeLabel(k))}</th>`).join('')}</tr></thead><tbody>${
    years.slice().reverse().map(y => `<tr><td>${y}</td>${keys.map(k => `<td class="num">${by.get(y).get(k) || 0}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------- subscriptions ----------------------------------------------------------

// Plain "All time" = no bound, so undated or pre-history items still show.
function periodQS() {
  const s = state.summary;
  if (!s || state.range === 'all') return '';
  return `&from=${s.range.from}&to=${s.range.to}`;
}

const avatarImg = (url, name, size = 36) => url
  ? `<img class="avatar" src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`
  : avatar(name);

async function loadSubs(page) {
  const r = await api(`/api/subs?page=${page}&sort=${state.subsSort.field}&dir=${state.subsSort.dir}${periodQS()}`);
  state.subsPage = page;
  $('#subs-caption').textContent = periodQS() ? `${nf.format(r.total)} in this period` : `${plural(r.current || 0, 'channel')} now`;
  $('#subs').innerHTML = r.items.length ? r.items.map(c => `
    <li>${avatarImg(c.avatar_url, c.title)}
      <div style="min-width:0"><a class="name" href="https://www.youtube.com/channel/${esc(c.channel_id)}" target="_blank" rel="noopener">${esc(c.title || c.channel_id)}</a>
      <div class="sub">${c.subscribed_day ? `since ${fmtDate(c.subscribed_day)}` : 'unknown date'}${c.subscribed ? '' : ' · no longer subscribed'}</div></div>
      <span class="n">${c.watched ? `${nf.format(c.watched)} watched` : esc(c.handle || '')}</span></li>`).join('')
    : `<li class="note" style="display:block">${periodQS() ? 'No subscriptions in this period.' : 'They arrive with the Google Takeout (My Activity).'}</li>`;
  $('#subs-pager').innerHTML = pagerHtml(page, r.pages);
}


// ---------- favourites & playlists ---------------------------------------------

async function loadSaves(page) {
  const r = await api(`/api/saves?page=${page}&sort=${state.savesSort.field}&dir=${state.savesSort.dir}${periodQS()}${themeQS()}`);
  state.savesPage = page;
  $('#saves-caption').textContent = r.total ? plural(r.total, 'video') : '';
  $('#saves').innerHTML = r.items.length ? r.items.map(v => `
    <li><a class="thumb" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${thumb(v.video_id)}">${v.duration_s ? `<span class="dur">${clock(v.duration_s)}</span>` : ''}</a>
      <div><a class="t" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener">${esc(v.title || v.video_id)}</a>
      <div class="m">${esc(v.channel_title || '')}</div>
      <div class="m">${v.day ? `saved ${fmtDate(v.day)}` : ''}${v.days_watched ? ` · watched on ${plural(v.days_watched, 'day')}` : ''}${v.liked ? ' · liked' : ''}</div></div></li>`).join('')
    : '<li class="note" style="display:block">No favorites yet: they arrive with the Google Takeout (YouTube and YouTube Music).</li>';
  $('#saves-pager').innerHTML = pagerHtml(page, r.pages);
}

async function loadLikes(page) {
  const r = await api(`/api/likes?page=${page}${periodQS()}${themeQS()}`);
  $('#likes-caption').textContent = r.total ? plural(r.total, 'video') : '';
  $('#likes').innerHTML = r.items.length ? r.items.map(v => `
    <li><a class="thumb" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${thumb(v.video_id)}">${v.duration_s ? `<span class="dur">${clock(v.duration_s)}</span>` : ''}</a>
      <div><a class="t" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener">${esc(v.title || v.video_id)}</a>
      <div class="m">${esc(v.channel_title || '')}</div>
      <div class="m">${v.day ? `liked ${fmtDate(v.day)}` : 'liked before tracking started'}${v.days_watched ? ` · watched on ${plural(v.days_watched, 'day')}` : ''}${v.favorite ? ' · in Favorites' : ''}</div></div></li>`).join('')
    : `<li class="note" style="display:block">${periodQS() ? 'No dated likes in this period.' : 'No liked videos yet.'}</li>`;
  $('#likes-pager').innerHTML = pagerHtml(page, r.pages);
}

// "On repeat" follows the most specific date context on screen: a chart selection,
// else the pinned day, else the active period.
function rewatchContext() {
  const s = state.summary;
  if (!s) return null;
  if (state.sel) return { ...state.sel };
  if (state.dayPinned && state.day) return { from: state.day, to: state.day, label: fmtLong.format(dayDate(state.day)) };
  return { from: s.range.from, to: s.range.to, label: state.range === 'all' ? null : state.range };
}

let rewatchSeq = 0;
async function loadRewatched() {
  const ctx = rewatchContext();
  if (!ctx) return;
  const seq = ++rewatchSeq;
  const qs = new URLSearchParams({ from: ctx.from, to: ctx.to });
  if (ctx.dow != null) { qs.set('dow', ctx.dow); qs.set('hour', ctx.hour); }
  if (ctx.channel) qs.set('channel', ctx.channel);
  const r = await api(`/api/rewatched?${qs}${themeQS()}`);
  if (seq !== rewatchSeq) return;
  $('#rep-caption').textContent = ctx.label ? `in ${ctx.label}` : 'in this period';
  $('#rewatched').innerHTML = r.items.length ? r.items.map(v => `
    <li><a class="thumb" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${thumb(v.video_id)}"></a>
      <div><a class="t" href="${watchUrl(v.video_id)}" target="_blank" rel="noopener">${esc(v.title || v.video_id)}</a>
      <div class="m">${esc(v.channel_title || '')}</div>
      <div class="m">${svgIcon('repeat').replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-2px"')} ${plural(v.views, 'time')}${v.days > 1 ? ` on ${plural(v.days, 'day')}` : ' the same day'} · last ${fmtDate(v.last_day)}</div></div></li>`).join('')
    : '<li class="note" style="display:block">Nothing watched more than once in this selection.</li>';
}

function renderSync(s) {
  const el = $('#sync');
  const last = s.meta.last_ping;
  el.classList.toggle('ok', !!last && Date.now() - last < 3 * 3600_000);
  el.classList.toggle('stale', !!last && Date.now() - last >= 3 * 3600_000);
  el.querySelector('.txt').textContent = last ? `Synced ${ago(last)}` : 'Extension not connected';
  el.title = last ? new Date(last).toLocaleString(LOCALE) : 'Install the browser extension to sync';
  $('#coverage').textContent = s.meta.pending_meta
    ? `${plural(s.meta.pending_meta, 'video')} waiting for metadata`
    : '';
}

// ---------- selection & active filters -------------------------------------------
// Two independent filters: the theme (narrows every panel) and one selection (what the
// list under the charts shows: a pinned day, a period, an hour slot, a channel...).
// Clicking whatever set a filter again clears it; every active one is listed on top.

function toggleSelection(sel) {
  if (state.sel?.key === sel.key) return clearSelection();
  return loadSelection(sel);
}

function clearSelection() {
  state.sel = null;
  return loadMain();
}

function pinDay(d) {
  if (!state.sel && state.dayPinned && state.day === d) return unpinDay();
  state.dayPinned = true;
  return loadDay(d, { scroll: true });
}

function unpinDay() {
  state.dayPinned = false;
  return loadMain();
}

// The period chips on top drive every panel. A selection belongs to the old period;
// a pinned day survives only if it is still inside the new one.
function setRange(r) {
  state.range = r;
  state.sel = null;
  if (state.dayPinned && r !== 'all' && state.day?.slice(0, 4) !== r) state.dayPinned = false;
  writeHash();
  return loadSummary();
}

function setTheme(t) {
  state.theme = t || null;
  writeHash();
  return loadSummary();
}

function markSelected() {
  const k = state.sel?.key;
  const pinned = !state.sel && state.dayPinned ? state.day : null;
  document.querySelectorAll('#activity .hit').forEach(h => h.classList.toggle('on',
    k === `a:${h.dataset.from}:${h.dataset.to}` || (h.dataset.unit === 'day' && h.dataset.from === pinned)));
  document.querySelectorAll('#hours rect.h').forEach(h => h.classList.toggle('on', k === `h:${h.dataset.dow}:${h.dataset.hour}`));
  document.querySelectorAll('#channels [data-channel]').forEach(li => li.setAttribute('aria-pressed', String(k === `c:${li.dataset.channel}`)));
  document.querySelectorAll('#theme-years rect.seg').forEach(r => r.classList.toggle('on',
    !!state.theme && r.dataset.year === state.range && r.dataset.theme === state.theme));
}

function renderActiveFilters() {
  loadRewatched().catch(showError);
  const chips = [];
  if (state.range !== 'all') chips.push(['year', `Year ${state.range}`]);
  if (state.theme) chips.push(['theme', `Topic: ${themeLabel(state.theme)}`]);
  if (state.sel) chips.push(['sel', state.sel.label]);
  else if (state.dayPinned && state.day) chips.push(['day', fmtLong.format(dayDate(state.day))]);
  const el = $('#active-filters');
  el.hidden = !chips.length;
  el.innerHTML = chips.length
    ? `<span class="note">Active filters</span>${chips.map(([k, label]) =>
        `<button class="chip filter-chip" data-clear="${k}" aria-label="Clear filter ${esc(label)}">${esc(label)}<span aria-hidden="true">✕</span></button>`).join('')}
       ${chips.length > 1 ? '<button class="chip ghost" data-clear="all">Clear all</button>' : ''}`
    : '';
  markSelected();
}

// ---------- the day (history view) -----------------------------------------------

function entryHtml(v) {
  const short = v.format === 'short';
  const dur = v.duration_s;
  const progress = v.secs && dur ? Math.min(100, (v.secs / dur) * 100) : 0;
  const time = v.ts ? fmtTime.format(new Date(v.ts)) : '';
  const url = watchUrl(v.video_id, short);
  const marks = [];
  if (v.total_days > 1) marks.push(`<span class="mark" title="First time: ${v.first_day}">${svgIcon('repeat')}Watched on ${plural(v.total_days, 'day')}</span>`);
  if (v.music) marks.push('<span class="mark">YouTube Music</span>');
  // Big, glanceable reaction icons on the right, like the user's sketch.
  const flags = [
    v.favorite ? `<span class="flag fav" title="In your Favorites">${svgIcon('heart')}</span>` : '',
    v.liked ? `<span class="flag like" title="Liked">${svgIcon('like')}</span>` : '',
    v.disliked ? `<span class="flag dislike" title="Disliked">${svgIcon('dislike')}</span>` : '',
  ].join('');
  const meta = [v.channel_title ? esc(v.channel_title) : null, time ? `at ${time}` : null].filter(Boolean).join(' · ');
  const watched = v.secs
    ? `<div class="watched">Watched ${clock(v.secs)}${dur ? ` of ${clock(dur)} (${pct.format(Math.min(1, v.secs / dur))})` : ''}</div>`
    : v.est_s ? `<div class="watched">≈ ${clock(v.est_s)} watched (estimated)${dur ? ` of ${clock(dur)}` : ''}</div>` : '';
  return `<li class="entry${short ? ' is-short' : ''}">
    <a class="thumb" href="${url}" target="_blank" rel="noopener" tabindex="-1">
      <img loading="lazy" alt="" src="${thumb(v.video_id)}">
      ${dur && !short ? `<span class="dur">${clock(dur)}</span>` : ''}
      ${progress ? `<span class="resume"><i style="width:${progress}%"></i></span>` : ''}
    </a>
    <div style="min-width:0">
      ${short ? `<span class="shorts-tag"><svg viewBox="0 0 24 28" aria-hidden="true"><use href="#i-shorts"/></svg>Shorts</span>` : ''}
      <a class="title" href="${url}" target="_blank" rel="noopener">${esc(v.title || `Video ${v.video_id}`)}</a>
      <div class="by">${meta}</div>
      ${watched}
      ${marks.length ? `<div class="marks">${marks.join('')}</div>` : ''}
    </div>
    <div class="flags">${flags}</div></li>`;
}

// The list under the charts shows, in this order: a chart selection, a pinned day, or
// the latest videos of the active period. Only the newest request may paint it.
let mainSeq = 0;
function loadMain(opts) {
  if (state.sel) return loadSelection(state.sel, opts);
  if (state.dayPinned && state.day) return loadDay(state.day, opts);
  return loadLatest(opts);
}

async function loadDay(d, { scroll = false } = {}) {
  const seq = ++mainSeq;
  state.day = d;
  state.sel = null;
  writeHash();
  renderActiveFilters();
  const el = $('#day');
  el.innerHTML = `<div class="day-head"><h2>${esc(fmtLong.format(dayDate(d)))}</h2></div>
    <div class="skeleton" style="height:138px;margin-top:12px"></div><div class="skeleton" style="height:138px;margin-top:16px"></div>`;
  const r = await api(`/api/day?d=${d}${themeQS()}`);
  if (seq !== mainSeq) return; // a newer click won
  const videos = r.videos;
  const measured = videos.reduce((a, v) => a + (v.secs || 0), 0);
  const likedNow = r.likes.length;
  const summary = [
    plural(videos.length, 'video'),
    measured ? `${hours(measured)} measured` : null,
    likedNow ? plural(likedNow, 'like') : null,
    state.theme ? `only ${esc(themeLabel(state.theme))}` : null,
  ].filter(Boolean).join(' · ');

  const extraLikes = r.likes.filter(l => !videos.find(v => v.video_id === l.video_id));
  el.innerHTML = `
    <div class="day-head">
      <h2>${esc(fmtLong.format(dayDate(d)))}</h2>
      <button class="icon-btn" data-go="${r.prev || ''}" ${r.prev ? '' : 'disabled'} aria-label="Previous day with activity">${svgIcon('prev')}</button>
      <button class="icon-btn" data-go="${r.next || ''}" ${r.next ? '' : 'disabled'} aria-label="Next day with activity">${svgIcon('next')}</button>
      <button class="chip" data-unpin>Show latest</button>
    </div>
    <p class="day-summary">${summary}</p>
    ${videos.length ? `<ol class="diary">${videos.map(entryHtml).join('')}</ol>`
      : `<div class="empty-state">${svgIcon('empty')}<strong>Nothing watched this day</strong>Or it was not recorded. Use the arrows to jump to the nearest day with activity.</div>`}
    ${extraLikes.length ? `<div class="day-extra"><h3>You also liked</h3><ul class="repeat">${
      extraLikes.map(l => `<li><a class="thumb" href="${watchUrl(l.video_id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${thumb(l.video_id)}"></a>
      <div><a class="t" href="${watchUrl(l.video_id)}" target="_blank" rel="noopener">${esc(l.title || l.video_id)}</a><div class="m">${esc(l.channel_title || '')}</div></div></li>`).join('')}</ul></div>` : ''}`;
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * A selection made by clicking a chart: a period (week, month), a weekday-hour slot
 * or a channel. sel = { key, label, from, to, dow?, hour?, channel? }
 */
function loadSelection(sel, { scroll = true, page = 0 } = {}) {
  state.sel = sel;
  renderActiveFilters();
  return loadList(sel, page, { scroll });
}

// Default view: the newest videos of the active period, whatever day they are from.
function loadLatest({ page = 0 } = {}) {
  const s = state.summary;
  const past = state.range !== 'all' && s.range.to < s.range.today;
  writeHash();
  renderActiveFilters();
  return loadList({ latest: true, label: past ? `Latest from ${state.range}` : 'Latest watched',
                    from: s.range.from, to: s.range.to, total: s.kpi.views }, page);
}

// Paged list (LIST_SIZE per page, newest first) with a separator per day.
const LIST_SIZE = 5;
async function loadList(sel, page = 0, { scroll = false } = {}) {
  const seq = ++mainSeq;
  state.list = sel;
  const el = $('#day');
  const qs = new URLSearchParams({ from: sel.from, to: sel.to, page, size: LIST_SIZE });
  if (sel.dow != null) { qs.set('dow', sel.dow); qs.set('hour', sel.hour); }
  if (sel.channel) qs.set('channel', sel.channel);
  if (sel.total != null) qs.set('total', sel.total); // already counted by the summary
  const body = el.querySelector('.sel-body');
  if (body && el.dataset.list === sel.label) body.classList.add('loading'); // page change: keep the frame
  else {
    el.innerHTML = `<div class="day-head"><h2>${esc(sel.label)}</h2></div>
      <div class="skeleton" style="height:138px;margin-top:12px"></div>`;
    if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const r = await api(`/api/videos?${qs}${themeQS()}`);
  if (seq !== mainSeq) return;
  let html = '', lastDay = null;
  for (const v of r.items) {
    if (v.day !== lastDay) {
      html += `${lastDay ? '</ol>' : ''}<h3 class="group-day"><button class="linkish" data-day="${v.day}" title="Show the whole day">${esc(fmtLong.format(dayDate(v.day)))}</button></h3><ol class="diary diary-group">`;
      lastDay = v.day;
    }
    html += entryHtml(v);
  }
  if (r.items.length) html += '</ol>';
  const pager = r.pages > 1
    ? `<div class="pager"><button class="chip" data-list-page="${page - 1}" ${page ? '' : 'disabled'}>Previous</button><span class="note">${nf.format(page + 1)} / ${nf.format(r.pages)}</span><button class="chip" data-list-page="${page + 1}" ${page + 1 < r.pages ? '' : 'disabled'}>Next</button></div>`
    : '';
  const summary = [`${plural(r.total, 'video')}${sel.latest ? ' in this period' : ''}`,
    state.theme ? `only ${esc(themeLabel(state.theme))}` : null].filter(Boolean).join(' · ');
  el.dataset.list = sel.label;
  el.innerHTML = `
    <div class="day-head">
      <h2>${esc(sel.label)}</h2>
      ${sel.latest ? '' : '<button class="chip" data-clear-sel>Clear selection</button>'}
    </div>
    <p class="day-summary">${summary}</p>
    <div class="sel-body">${r.items.length ? html : `<div class="empty-state">${svgIcon('empty')}<strong>Nothing in this selection</strong></div>`}${pager}</div>`;
}

// ---------- search ----------------------------------------------------------------

let searchTimer, searchSeq = 0;
async function runSearch(q) {
  const box = $('#search-results');
  if (q.trim().length < 2) { box.hidden = true; return; }
  const seq = ++searchSeq;
  const r = await api(`/api/search?q=${encodeURIComponent(q.trim())}`);
  if (seq !== searchSeq) return;
  box.hidden = false;
  box.innerHTML = r.results.length ? r.results.map(v => `
    <button type="button" data-day="${v.last_day}">
      <img loading="lazy" alt="" src="${thumb(v.video_id)}">
      <div style="min-width:0"><div class="t">${esc(v.title || v.video_id)}</div>
      <div class="m">${esc(v.channel_title || '')}</div>
      <div class="m">${v.days > 1 ? `${plural(v.days, 'day')} · ` : ''}last ${fmtDate(v.last_day)}</div></div>
    </button>`).join('') : `<div class="empty">Nothing in your history matches “${esc(q)}”.</div>`;
}

// ---------- loading ----------------------------------------------------------------

function rangeDates(today) {
  // One period for the whole dashboard: everything, or one calendar year.
  if (state.range === 'all') return { from: '2005-04-23', to: today }; // first YouTube upload
  const to = `${state.range}-12-31`;
  return { from: `${state.range}-01-01`, to: to > today ? today : to };
}

async function loadSummary() {
  const d0 = new Date(); const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const { from, to } = rangeDates(today);
  const s = await api(`/api/summary?from=${from}&to=${to}${themeQS()}`);
  if (state.range === 'all' && s.meta.first_day) {
    // Re-anchor "All time" to the first real day so the activity chart has no empty decade.
    s.range.from = s.meta.first_day;
  }
  if (!state.themeYears) {
    // All-time theme order fixes each theme's colour before anything is drawn.
    state.themeYears = await api('/api/themes');
    const tot = new Map();
    for (const r of state.themeYears.rows) if (r.id !== 'pending') tot.set(r.id, (tot.get(r.id) || 0) + r.n);
    state.themeOrder = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  state.summary = s;
  state.themeList = s.themes.list;
  $('#range-caption').textContent = `${fmtDate(s.range.from)} – ${fmtDate(s.range.to)}`;
  showPanels(s);
  renderRanges(s);
  renderFigures(s);
  renderActivity(s);
  renderHours(s);
  renderFormats(s);
  renderSync(s);
  renderThemes(s);
  renderThemeYears(state.themeYears);
  markSelected();
  // Every panel follows the active period.
  const m = s.meta;
  if (m.first_day) loadChannels(0).catch(showError);
  if (m.n_favorites) loadSaves(0).catch(showError);
  if (m.n_likes) loadLikes(0).catch(showError);
  if (m.n_subs) loadSubs(0).catch(showError);
  renderActiveFilters();
  if (!s.meta.first_day) {
    const other = m.n_likes || m.n_favorites || m.n_subs;
    $('#day').innerHTML = other
      ? `<div class="empty-state">${svgIcon('empty')}<strong>No watch history imported</strong>
        Turn on “Watch history” in the extension and run a Full import to see what you watched, day by day.</div>`
      : `<div class="empty-state">${svgIcon('empty')}<strong>Nothing to show yet</strong>
        Install the browser extension or import your Google Takeout and your history will appear here, day by day.</div>`;
    return;
  }
  await loadMain({ scroll: false });
}

// ---------- wiring ----------------------------------------------------------------

function wire() {
  $('#ranges').addEventListener('click', e => {
    const b = e.target.closest('[data-range]');
    if (b) setRange(b.dataset.range === state.range ? 'all' : b.dataset.range).catch(showError);
  });
  $('#active-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-clear]');
    if (!b) return;
    const k = b.dataset.clear;
    if (k === 'theme') setTheme(null).catch(showError);
    else if (k === 'sel') clearSelection().catch(showError);
    else if (k === 'day') unpinDay().catch(showError);
    else if (k === 'year') setRange('all').catch(showError);
    else { state.sel = null; state.dayPinned = false; state.range = 'all'; setTheme(null).catch(showError); }
  });
  $('#act-metric').addEventListener('click', e => {
    const b = e.target.closest('[data-metric]');
    if (!b || b.dataset.metric === state.metric || !state.summary) return;
    state.metric = b.dataset.metric;
    writeHash();
    renderActivity(state.summary);
  });
  $('#activity').addEventListener('click', e => {
    const b = e.target.closest('[data-from]');
    if (!b) return;
    if (b.dataset.unit === 'day') pinDay(b.dataset.from).catch(showError);
    else toggleSelection({ key: `a:${b.dataset.from}:${b.dataset.to}`, label: b.dataset.label, from: b.dataset.from, to: b.dataset.to }).catch(showError);
  });
  $('#activity').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.from) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  $('#hours').addEventListener('click', e => {
    const c = e.target.closest('[data-dow]');
    if (!c || !state.summary) return;
    const { from, to } = state.summary.range, d = Number(c.dataset.dow), h = Number(c.dataset.hour);
    toggleSelection({ key: `h:${d}:${h}`, label: `${DOW_LONG[d]}s at ${h}:00`, from, to, dow: d, hour: h }).catch(showError);
  });
  const pickChannel = e => {
    if (e.target.closest('a')) return; // the ↗ link opens YouTube
    const li = e.target.closest('[data-channel]');
    if (!li || !state.summary) return;
    const { from, to } = state.summary.range;
    toggleSelection({ key: `c:${li.dataset.channel}`, label: li.dataset.label, from, to, channel: li.dataset.channel }).catch(showError);
  };
  $('#channels').addEventListener('click', pickChannel);
  $('#channels').addEventListener('keydown', e => { if (e.key === 'Enter') pickChannel(e); });
  $('#theme-rank').addEventListener('click', e => {
    const li = e.target.closest('[data-theme]');
    if (li) setTheme(li.dataset.theme === state.theme ? null : li.dataset.theme).catch(showError);
  });
  $('#theme-rank').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.theme) { e.preventDefault(); e.target.click(); }
  });
  $('#theme-more').addEventListener('click', () => {
    state.themesExpanded = !state.themesExpanded;
    renderThemes(state.summary);
  });
  $('#theme-years').addEventListener('click', e => {
    const seg = e.target.closest('[data-year]');
    if (!seg) return;
    const y = seg.dataset.year, t = seg.dataset.theme === 'rest' ? null : seg.dataset.theme;
    const same = state.range === y && state.theme === t;
    state.theme = same ? null : t;
    setRange(same ? 'all' : y).catch(showError);
  });
  $('#day').addEventListener('click', e => {
    if (e.target.closest('[data-clear-sel]')) { clearSelection().catch(showError); return; }
    if (e.target.closest('[data-unpin]')) { unpinDay().catch(showError); return; }
    const pg = e.target.closest('[data-list-page]');
    if (pg && state.list) { loadList(state.list, Number(pg.dataset.listPage)).catch(showError); return; }
    const g = e.target.closest('.group-day [data-day]');
    if (g) { pinDay(g.dataset.day).catch(showError); return; }
    const b = e.target.closest('[data-go]');
    if (b?.dataset.go) { state.dayPinned = true; loadDay(b.dataset.go).catch(showError); }
  });
  $('#search-results').addEventListener('click', e => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    $('#search-results').hidden = true;
    state.dayPinned = true;
    loadDay(b.dataset.day, { scroll: true }).catch(showError);
  });
  $('#q').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value).catch(showError), 220); });
  $('#search-form').addEventListener('submit', e => { e.preventDefault(); runSearch($('#q').value).catch(showError); });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) $('#search-results').hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') $('#search-results').hidden = true;
    if (document.activeElement?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' || e.key === 'j') $('#day [data-go]')?.click();
    if (e.key === 'ArrowRight' || e.key === 'l') $('#day [data-go]:last-of-type')?.click();
  });
  $('#theme').addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: light)').matches ? document.documentElement.dataset.theme === 'dark' : document.documentElement.dataset.theme !== 'light';
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('visto-theme', next); } catch {}
  });
  ['#activity', '#hours', '#formats', '#theme-years'].forEach(s => bindTips($(s)));
  // Two chips per list (date / views). Clicking the active one flips its direction.
  const SORT_LABELS = {
    recent: { desc: 'Newest', asc: 'Oldest' },
    watched: { desc: 'Most watched', asc: 'Least watched' },
  };
  const paintSort = (sel, key) => $(sel).querySelectorAll('[data-sort]').forEach(x => {
    const on = x.dataset.sort === state[key].field;
    const dir = on ? state[key].dir : 'desc';
    x.setAttribute('aria-pressed', String(on));
    x.textContent = `${SORT_LABELS[x.dataset.sort][dir]}${on ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}`;
    x.title = on ? 'Click again to reverse the order' : '';
  });
  const sorter = (sel, key, load) => {
    paintSort(sel, key);
    $(sel).addEventListener('click', e => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      state[key] = b.dataset.sort === state[key].field
        ? { field: state[key].field, dir: state[key].dir === 'desc' ? 'asc' : 'desc' }
        : { field: b.dataset.sort, dir: 'desc' };
      paintSort(sel, key);
      load(0).catch(showError);
    });
  };
  sorter('#saves-sort', 'savesSort', loadSaves);
  sorter('#subs-sort', 'subsSort', loadSubs);
  $('#subs-pager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b) loadSubs(Number(b.dataset.page)).catch(showError);
  });
  $('#channels-pager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b) loadChannels(Number(b.dataset.page)).catch(showError);
  });
  $('#likes-pager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b) loadLikes(Number(b.dataset.page)).catch(showError);
  });
  $('#saves-pager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b) loadSaves(Number(b.dataset.page)).catch(showError);
  });
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!state.summary) return;
      renderActivity(state.summary); renderHours(state.summary);
      if (state.themeYears) renderThemeYears(state.themeYears);
      markSelected();
    }, 150);
  });
}

function showError(err) {
  console.error(err);
  $('#day').innerHTML = `<div class="empty-state"><strong>Something went wrong</strong>${esc(err.message)}</div>`;
}

readHash();
wire();
loadSummary().catch(showError);
