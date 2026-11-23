// Smeltworks Idle telemetry dashboard.
// All client-side. Worker URL + token live in localStorage on this device.
// Never commit a token to the repo — they're paste-on-load only.
//
// Data sources:
//   GET  /summary       merged per-day rollups (summary/all.json) — history charts
//   POST /rollup?day=   fold new raw files into the rollups (backfill on load)
//   GET  /events        latest ~45 raw uploads — the "recent sessions" feed

const LS_URL = "smeltworks-idle.worker_url";
const LS_TOKEN = "smeltworks-idle.token";
const LS_RANGE = "smeltworks-idle.range";

// Default worker URL — not a secret (it's in the game's source). Saved
// localStorage value still takes precedence if the user changed it.
const DEFAULT_WORKER_URL = "https://smeltworks-idle-logging.sdwr.workers.dev";

// How many rollup calls a single refresh may issue (each reads <= 38 files).
const MAX_ROLLUP_CALLS = 30;
// Runs shown in the feed before a "show more" button.
const FEED_PAGE = 40;

const SERIES = [
  { key: "runs", label: "runs", color: "var(--s-runs)" },
  { key: "installs", label: "players", color: "var(--s-players)" },
  { key: "errors", label: "errors", color: "var(--s-crashes)" },
];

const $ = (id) => document.getElementById(id);

// ---- state ----
let summaryData = null;   // { today, days, all }
let dates = {};           // event-date -> merged metrics
let rangeDays = Number(localStorage.getItem(LS_RANGE) || 30);
let feedEvents = [];      // last fetched raw events (for client-side re-sort)
let activityRows = [];    // rows behind the activity chart (for the table view)
let backfillPending = false; // true when a refresh hit the rollup budget
let feedLimit = FEED_PAGE;

// ============================================================
// Credentials / settings
// ============================================================

function setStatus(msg, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.classList.toggle("error", isError);
}

function loadCreds() {
  $("worker-url").value = localStorage.getItem(LS_URL) || DEFAULT_WORKER_URL;
  $("token").value = localStorage.getItem(LS_TOKEN) || "";
}

function saveCreds() {
  let url = $("worker-url").value.trim().replace(/\/$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  // This page is served over https, so an http:// worker URL would be blocked
  // as mixed content and fetch() rejects with an opaque "Failed to fetch".
  // Upgrade it (except for localhost, used during local dev).
  if (url && location.protocol === "https:" && /^http:\/\//i.test(url) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
    url = url.replace(/^http:/i, "https:");
  }
  $("worker-url").value = url;
  localStorage.setItem(LS_URL, url);
  localStorage.setItem(LS_TOKEN, $("token").value.trim());
}

function clearCreds() {
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_TOKEN);
  $("worker-url").value = DEFAULT_WORKER_URL;
  $("token").value = "";
  $("content").hidden = true;
  $("empty").hidden = false;
  setStatus("forgot credentials.");
}

function hasCreds() {
  return !!(localStorage.getItem(LS_URL) && localStorage.getItem(LS_TOKEN));
}

function toggleSettings(force) {
  const el = $("settings");
  const show = force != null ? force : el.hidden;
  el.hidden = !show;
  $("settings-toggle").setAttribute("aria-expanded", String(show));
}

async function api(path, opts = {}) {
  const base = localStorage.getItem(LS_URL);
  const token = localStorage.getItem(LS_TOKEN);
  if (!base || !token) throw new Error("missing worker URL or token");
  let res;
  try {
    res = await fetch(base + path, {
      method: opts.method || "GET",
      headers: { Authorization: "Bearer " + token },
    });
  } catch (e) {
    throw new Error(`could not reach worker at ${base} — check the URL, your network, or ad-blockers (${e.message})`);
  }
  if (res.status === 401) throw new Error("unauthorized — check the token");
  if (!res.ok) throw new Error(`worker returned ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ============================================================
// Refresh pipeline
// ============================================================

async function refresh() {
  if (!hasCreds()) { toggleSettings(true); return; }
  setStatus("loading summary…");
  document.body.classList.add("loading");
  try {
    summaryData = await api("/summary");
    await backfillRollups();
    rebuildDates();
    renderHistory();
    $("empty").hidden = true;
    $("content").hidden = false;
    await refreshFeed();
    const n = Object.keys(dates).length;
    setStatus(`${n} day${n === 1 ? "" : "s"} of history · updated ${new Date().toLocaleTimeString()}` +
      (backfillPending ? " · older days still rolling up — refresh again" : ""));
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    document.body.classList.remove("loading");
  }
}

// Fold any raw files the rollups haven't seen yet. Past days are done once
// `complete`; today is always re-rolled (it only reads files newer than the
// stored cursor, so this is cheap).
async function backfillRollups() {
  const { today, days, all } = summaryData;
  backfillPending = false;
  const todo = [];
  for (const d of days) {
    if (d === today) todo.push(d);
    else if (d < today && !(all.days[d] && all.days[d].complete)) todo.push(d);
  }
  // Newest first so the most relevant history fills in earliest.
  todo.sort().reverse();
  if (!todo.length) return;

  let calls = 0, dirty = false;
  for (const day of todo) {
    let remaining = true;
    while (remaining && calls < MAX_ROLLUP_CALLS) {
      setStatus(`rolling up ${day}… (${calls + 1}/${MAX_ROLLUP_CALLS})`);
      const r = await api("/rollup?day=" + day, { method: "POST" });
      calls++; dirty = true;
      remaining = r.remaining;
    }
    if (calls >= MAX_ROLLUP_CALLS) break;
  }
  if (dirty) summaryData = await api("/summary");
  backfillPending = calls >= MAX_ROLLUP_CALLS;
}

// Merge every receipt-day's per-date metrics into one date -> metrics map.
function rebuildDates() {
  dates = {};
  for (const day of Object.values(summaryData.all.days || {})) {
    for (const [date, m] of Object.entries(day.dates || {})) {
      const t = (dates[date] ||= emptyMetrics());
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "number") t[k] = (t[k] || 0) + v;
        else if (v && typeof v === "object") {
          const tc = (t[k] ||= {});
          for (const [kk, vv] of Object.entries(v)) tc[kk] = (tc[kk] || 0) + Number(vv || 0);
        }
      }
    }
  }
}

// Keep in step with DateMetrics in ../src/index.ts.
function emptyMetrics() {
  return {
    events: 0, runs: 0, installs: 0, sessions: 0, new_players: 0, errors: 0,
    run_starts: 0, run_ends: 0, new_deepest: 0, secs: 0, levels: 0, kills: 0, fails: 0, cores: 0, weapons: 0, ups: 0, skills: 0,
    ends_by_level: {}, ends_by_run: {}, secs_by_run: {}, level_by_run: {}, cores_by_run: {}, starts_by_run: {}, nodes_by_run: {},
    nodes_held: {}, nodes_bought: {}, nodes_dropped: {}, node_buy_run: {},
    progress: 0, open_at: {}, reach_n: {}, reach_secs: {}, fails_by_level: {},
    counts: {}, os: {}, versions: {}, error_messages: {},
  };
}

// The prestige tree's nodes by id (nodes.js, generated from the game). A node the page does not know keeps its id.
const NODE = typeof NODES === "object" && NODES ? NODES : {};
function nodeLabel(id) { const n = NODE[id]; return n ? `${n.n} · ${id}` : id; }
function nodeTitle(id) { const n = NODE[id]; return n ? `${n.n} (${id}): ${n.t} · ${n.c} cores` : id; }

// ---- date helpers ----
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateSpan(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso) {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

// The current period, and the equal-length period before it (for deltas).
function periods() {
  const today = summaryData.today;
  const known = Object.keys(dates).sort();
  let from;
  if (rangeDays > 0) from = addDays(today, -(rangeDays - 1));
  else from = known[0] || today;
  const cur = dateSpan(from, today);
  const prev = rangeDays > 0 ? dateSpan(addDays(from, -rangeDays), addDays(from, -1)) : [];
  return { cur, prev };
}

function sumMetrics(dayList) {
  const t = emptyMetrics();
  for (const d of dayList) {
    const m = dates[d];
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "number") t[k] = (t[k] || 0) + v;
      else for (const [kk, vv] of Object.entries(v || {})) (t[k] ||= {})[kk] = (t[k][kk] || 0) + vv;
    }
  }
  return t;
}

// ============================================================
// History rendering
// ============================================================

function renderHistory() {
  const { cur, prev } = periods();
  const curTotals = sumMetrics(cur);
  const prevTotals = prev.length ? sumMetrics(prev) : null;
  renderTiles(cur, curTotals, prevTotals);
  renderActivity(cur);
  renderAggregates(curTotals);
  $("activity-sub").textContent = rangeDays > 0
    ? `last ${rangeDays} days · per day`
    : `${shortDate(cur[0])} – ${shortDate(cur[cur.length - 1])} · per day`;
}

function renderTiles(cur, t, p) {
  const per = (sum, n) => (n ? sum / n : 0);
  const defs = [
    { key: "runs", label: "runs", good: "up" },
    { key: "installs", label: "player-days", good: "up" },      // distinct players per day, summed over the range
    { key: "new_players", label: "new players", good: "up" },
    { key: "run_ends", label: "runs finished", good: "up" },
    { key: "avg_run_secs", label: "avg run", good: null, time: true, derived: (m) => per(m.secs, m.run_ends) },
    { key: "avg_depth", label: "avg depth", good: "up", places: 1, derived: (m) => per(m.levels, m.run_ends) },
    { key: "avg_fails", label: "lost fights / run", good: "down", places: 1, derived: (m) => per(m.fails, m.run_ends) },
    { key: "errors", label: "errors", good: "down" },
  ];
  const el = $("tiles");
  el.innerHTML = "";
  for (const d of defs) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const get = (m) => (d.derived ? d.derived(m) : m[d.key] || 0);
    const val = get(t);
    const show = (v) => (d.time ? fmtShort(v) : d.places ? v.toFixed(d.places) : fmt(v));
    let deltaHtml = "";
    if (p) {
      const pv = get(p);
      const diff = val - pv;
      let cls = "";
      if (diff !== 0 && d.good) cls = (diff > 0) === (d.good === "up") ? "up" : "down";
      const pct = pv > 0 ? ` (${diff > 0 ? "+" : ""}${Math.round(100 * diff / pv)}%)` : "";
      const txt = show(Math.abs(diff)) === show(0) ? "no change" : `${diff > 0 ? "+" : "-"}${show(Math.abs(diff))}${pct}`;
      deltaHtml = `<span class="delta ${cls}" title="vs previous ${cur.length} days">${txt}</span>`;
    } else {
      deltaHtml = `<span class="delta">all time</span>`;
    }
    tile.innerHTML = `<span class="lbl">${escapeHtml(d.label)}</span><span class="val">${show(val)}</span>${deltaHtml}`;
    tile.appendChild(sparkline(cur.map((day) => (dates[day] ? get(dates[day]) : 0))));
    el.appendChild(tile);
  }
}

function sparkline(values) {
  const W = 72, H = 32;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i) => n === 1 ? W : (i / (n - 1)) * W;
  const y = (v) => H - 2 - (v / max) * (H - 4);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  if (n > 1) {
    const base = document.createElementNS("http://www.w3.org/2000/svg", "path");
    base.setAttribute("d", "M" + pts.join(" L"));
    svg.appendChild(base);
  }
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", x(n - 1)); dot.setAttribute("cy", y(values[n - 1] || 0)); dot.setAttribute("r", 2.5);
  svg.appendChild(dot);
  return svg;
}

// ---- activity line chart ----
function renderActivity(cur) {
  activityRows = cur.map((d) => {
    const m = dates[d] || {};
    const row = { date: d };
    for (const s of SERIES) row[s.key] = m[s.key] || 0;
    return row;
  });
  const legend = $("activity-legend");
  legend.innerHTML = SERIES.map((s) => `<span class="key"><i style="--c:${s.color}"></i>${escapeHtml(s.label)}</span>`).join("");
  drawLineChart($("activity-chart"), activityRows, SERIES);
  renderActivityTable();
}

function renderActivityTable() {
  const el = $("activity-table");
  const head = `<tr><th>date</th>${SERIES.map((s) => `<th>${escapeHtml(s.label)}</th>`).join("")}</tr>`;
  const body = [...activityRows].reverse().map((r) =>
    `<tr><td>${r.date}</td>${SERIES.map((s) => `<td>${r[s.key]}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawLineChart(container, rows, series) {
  container.innerHTML = "";
  container.classList.remove("hovering");
  $("tooltip").hidden = true;
  const W = Math.max(320, container.clientWidth || 800);
  const H = container.clientHeight || 260;
  const M = { l: 40, r: 56, t: 12, b: 26 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const n = rows.length;
  const maxV = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key]))));
  const x = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => M.t + ih - (v / maxV) * ih;

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

  // grid + y axis
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i;
    el("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }, grid);
    const t = el("text", { x: M.l - 8, y: y(v) + 4, "text-anchor": "end" }, axis);
    t.textContent = fmt(v);
  }
  // x labels: ~6 evenly spaced
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    const t = el("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : "middle" }, axis);
    t.textContent = shortDate(rows[i].date);
  }

  // series
  for (const s of series) {
    const g = el("g", { class: "series", style: `--c:${s.color}` }, svg);
    const pts = rows.map((r, i) => [x(i), y(r[s.key])]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    if (n > 1) {
      el("path", { class: "area", d: `${d} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` }, g);
      el("path", { class: "line", d }, g);
    }
    const last = pts[n - 1];
    el("circle", { cx: last[0], cy: last[1], r: 4 }, g);
    const lbl = el("text", { class: "end-label", x: last[0] + 8, y: last[1] + 4 }, g);
    lbl.textContent = fmt(rows[n - 1][s.key]);
  }
  // Nudge colliding end-labels apart (leader-free: they sit right of the plot).
  const labels = [...svg.querySelectorAll(".end-label")].sort((a, b) => Number(a.getAttribute("y")) - Number(b.getAttribute("y")));
  for (let i = 1; i < labels.length; i++) {
    const prev = Number(labels[i - 1].getAttribute("y")), cur = Number(labels[i].getAttribute("y"));
    if (cur - prev < 12) labels[i].setAttribute("y", prev + 12);
  }

  // hover layer
  const cross = el("line", { class: "crosshair", y1: M.t, y2: M.t + ih, x1: 0, x2: 0 }, svg);
  const dots = series.map((s) => el("circle", { class: "hover-dot", r: 4, style: `--c:${s.color}` }, svg));
  const hit = el("rect", { x: M.l, y: M.t, width: iw, height: ih, fill: "transparent" }, svg);
  const tip = $("tooltip");

  const showAt = (i, clientX, clientY) => {
    const r = rows[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    series.forEach((s, k) => { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(r[s.key])); });
    container.classList.add("hovering");
    tip.innerHTML = "";
    const title = document.createElement("div");
    title.className = "tt-title"; title.textContent = r.date;
    tip.appendChild(title);
    for (const s of series) {
      const row = document.createElement("div");
      row.className = "tt-row";
      const key = document.createElement("i"); key.style.setProperty("--c", s.color);
      const b = document.createElement("b"); b.textContent = String(r[s.key]);
      const span = document.createElement("span"); span.textContent = s.label;
      row.append(key, b, span);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = clientX + 14, top = clientY - th / 2;
    if (left + tw > window.innerWidth - 8) left = clientX - tw - 14;
    top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
    tip.style.left = left + "px"; tip.style.top = top + "px";
  };
  const hide = () => { container.classList.remove("hovering"); tip.hidden = true; };
  hit.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const i = n === 1 ? 0 : Math.round(((px - M.l) / iw) * (n - 1));
    showAt(Math.max(0, Math.min(n - 1, i)), ev.clientX, ev.clientY);
  });
  hit.addEventListener("pointerleave", hide);
  container.appendChild(svg);
}

// ---- aggregate bar charts ----

// Runs are numbered from 1 on each save. The first ten get a row each, later ones share rows.
const RUN_BANDS = [[11, 15], [16, 20], [21, 30], [31, 40], [41, 59], [60, 60]];
function runBands(counts) {
  const keys = Object.keys(counts || {}).map(Number).filter((n) => counts[n] > 0);
  if (!keys.length) return [];
  const max = Math.max(...keys), out = [];
  for (let n = 1; n <= Math.min(10, max); n++) out.push({ label: "run " + n, from: n, to: n });
  for (const [from, to] of RUN_BANDS) if (max >= from) out.push({ label: from === 60 ? "run 60+" : `runs ${from}-${to}`, from, to });
  return out;
}
const bandSum = (obj, band) => { let t = 0; for (let n = band.from; n <= band.to; n++) t += (obj && obj[n]) || 0; return t; };

// Deepest levels in rows of one level, or of five or twenty-five once runs go deep.
function levelBands(...maps) {
  const ends = {};
  for (const m of maps) for (const [k, v] of Object.entries(m || {})) if (v > 0) ends[k] = (ends[k] || 0) + v;
  const keys = Object.keys(ends).map(Number);
  if (!keys.length) return [];
  const max = Math.max(...keys), step = max <= 24 ? 1 : max <= 120 ? 5 : 25, out = [];
  for (let from = 1; from <= max; from += step) {
    const to = from + step - 1;
    out.push({ label: step === 1 ? "L" + from : `L${from}-${to}`, from, to });
  }
  while (out.length && !bandSum(ends, out[0])) out.shift();
  return out;
}

const FORGE_ROWS = [
  ["forged", "forged"], ["equipped", "equipped"], ["scrapped", "scrapped"],
  ["reroll_type", "type rerolls"], ["reroll_sockets", "socket rerolls"], ["upgrade", "upgrades"], ["upgrade_ranks", "upgrade ranks"],
];
const CRAFT_ROWS = [
  ["drops", "dropped"], ["market", "bought"], ["salvage", "salvaged"],
  ["craft_add", "add affix"], ["craft_third", "third affix"], ["craft_strip", "remove affix"], ["craft_recast", "recast"], ["craft_morph", "morph"],
];

function renderAggregates(t) {
  const runsTitle = (n) => `${n} run${n === 1 ? "" : "s"}`;

  // where runs end: one row per level (or band of levels). Prestiged there, or last heard from there with no prestige.
  // open_at counts each run at the level it last reported; the ones that prestiged there are in ends_by_level.
  const ends = t.ends_by_level || {}, open = t.open_at || {};
  const levels = levelBands(ends, open, t.reach_n);
  $("depth-legend").innerHTML =
    `<span class="key"><i class="box" style="--c:var(--good)"></i>prestiged</span>` +
    `<span class="key"><i class="box" style="--c:var(--critical)"></i>stopped</span>`;
  const stoppedAt = (b) => { let n = 0; for (let l = b.from; l <= b.to; l++) n += Math.max(0, (open[l] || 0) - (ends[l] || 0)); return n; };
  renderBars("chart-depth", levels.map((b) => {
    const done = bandSum(ends, b), stop = stoppedAt(b);
    return { label: b.label, segs: [
      { v: done, c: "var(--good)", title: `${runsTitle(done)} prestiged at ${b.label}` },
      { v: stop, c: "var(--critical)", title: `${runsTitle(stop)} stopped at ${b.label} without a prestige` },
    ], text: `${done} · ${stop} stopped` };
  }).filter((r) => r.segs[0].v || r.segs[1].v), { wideVal: true });

  // pacing: how far into a run each level is first reached, and how many fights are lost on it
  const reached = levels.map((b) => ({ ...b, n: bandSum(t.reach_n, b) })).filter((b) => b.n > 0);
  renderBars("chart-reach", reached.map((b) => {
    const secs = bandSum(t.reach_secs, b) / b.n;
    return { label: b.label, segs: [{ v: secs, c: "var(--s-runs)", title: `${b.n} time${b.n === 1 ? "" : "s"} a run reached ${b.label}` }], text: fmtSecs(secs) };
  }));
  renderBars("chart-fails", reached.map((b) => {
    const f = bandSum(t.fails_by_level, b), per = f / b.n;
    return { label: b.label, segs: [{ v: per, c: "var(--critical)", title: `${f} fight${f === 1 ? "" : "s"} lost at ${b.label}, reached ${b.n} time${b.n === 1 ? "" : "s"}` }], text: per.toFixed(2) };
  }));

  // by run number: how deep, how long, what it earned
  const bands = runBands(t.ends_by_run).map((b) => ({ ...b, n: bandSum(t.ends_by_run, b) })).filter((b) => b.n > 0);
  renderBars("chart-depth-run", bands.map((b) => {
    const lv = bandSum(t.level_by_run, b) / b.n, cores = bandSum(t.cores_by_run, b) / b.n;
    return { label: b.label, segs: [{ v: lv, c: "var(--s-players)", title: runsTitle(b.n) }], text: `L${lv.toFixed(1)} · ${fmt(cores)} cores` };
  }), { wideVal: true });
  renderBars("chart-duration", bands.map((b) => {
    const secs = bandSum(t.secs_by_run, b) / b.n;
    return { label: b.label, segs: [{ v: secs, c: "var(--s-runs)", title: runsTitle(b.n) }], text: fmtSecs(secs) };
  }));
  renderBars("chart-finished", runBands(t.starts_by_run).map((b) => ({ ...b, n: bandSum(t.starts_by_run, b), done: bandSum(t.ends_by_run, b) })).filter((b) => b.n > 0).map((b) => (
    { label: b.label, segs: [{ v: Math.min(100, 100 * b.done / b.n), c: "var(--good)", title: `${b.done} of ${b.n} runs begun were finished` }], text: `${Math.min(100, Math.round(100 * b.done / b.n))}% · ${b.n}` })), { max: 100, wideVal: true });
  const starts = runBands(t.starts_by_run).map((b) => ({ ...b, n: bandSum(t.starts_by_run, b) })).filter((b) => b.n > 0);
  renderBars("chart-tree", starts.map((b) => {
    const nodes = bandSum(t.nodes_by_run, b) / b.n;
    return { label: b.label, segs: [{ v: nodes, c: "var(--accent)", title: `${b.n} run${b.n === 1 ? "" : "s"} begun` }], text: nodes.toFixed(1) };
  }));

  // what was done in a run, per finished run; and what the line looked like when it ended
  const perRun = (v) => (t.run_ends ? v / t.run_ends : 0);
  const doneRows = (defs, c) => defs.map(([k, label]) => {
    const v = (t.counts && t.counts[k]) || 0;
    return { label, segs: [{ v: perRun(v), c, title: `${v} in ${t.run_ends} finished runs` }], text: perRun(v).toFixed(2) };
  });
  const known = new Set([...FORGE_ROWS, ...CRAFT_ROWS].map((r) => r[0]));
  const other = Object.keys(t.counts || {}).filter((k) => !known.has(k)).sort().map((k) => [k, k.replace(/_/g, " ")]);
  const endRows = [["weapons", "weapons at end"], ["ups", "ranks at end"], ["skills", "skills at end"]].map(([k, label]) => (
    { label, segs: [{ v: perRun(t[k] || 0), c: "var(--muted)", title: `${t[k] || 0} over ${t.run_ends} finished runs` }], text: perRun(t[k] || 0).toFixed(2) }));
  renderBars("chart-forge", t.run_ends ? [...doneRows(FORGE_ROWS, "var(--accent)"), ...endRows] : []);
  renderBars("chart-craft", t.run_ends ? doneRows([...CRAFT_ROWS, ...other], "var(--s-players)") : []);

  // the tree: what is bought (and when), what runs begin with, what is handed back
  renderBars("chart-bought", topEntries(t.nodes_bought, 200).map(([id, v]) => {
    const at = v ? ((t.node_buy_run && t.node_buy_run[id]) || 0) / v : 0;
    return { label: nodeLabel(id), title: nodeTitle(id), segs: [{ v, c: "var(--s-runs)", title: `${nodeTitle(id)} — bought ${v} time${v === 1 ? "" : "s"}` }], text: `${v} · run ${at.toFixed(1)}` };
  }), { wide: true, wideVal: true });
  renderBars("chart-held", topEntries(t.nodes_held, 200).map(([id, v]) => (
    { label: nodeLabel(id), title: nodeTitle(id), segs: [{ v: t.run_starts ? 100 * v / t.run_starts : 0, c: "var(--s-players)", title: `${nodeTitle(id)} — ${v} of ${t.run_starts} runs` }], text: t.run_starts ? Math.round(100 * v / t.run_starts) + "%" : String(v) })), { wide: true, max: 100 });
  renderBars("chart-dropped", topEntries(t.nodes_dropped, 200).map(([id, v]) => {
    const bought = (t.nodes_bought && t.nodes_bought[id]) || 0;
    return { label: nodeLabel(id), title: nodeTitle(id), segs: [{ v, c: "var(--critical)", title: `${nodeTitle(id)} — handed back ${v} time${v === 1 ? "" : "s"}, bought ${bought}` }], text: String(v) };
  }), { wide: true });
  const unheld = $("chart-unheld");
  const never = Object.keys(NODE).filter((id) => !(t.nodes_held && t.nodes_held[id]));
  unheld.innerHTML = !t.run_starts ? '<div class="nodata">no data in this range.</div>'
    : !never.length ? '<div class="nodata">every node was held by some run.</div>'
    : never.map((id) => `<span class="chip${NODE[id].big ? " big" : ""}" title="${escapeHtml(nodeTitle(id))}">${escapeHtml(nodeLabel(id))}</span>`).join("");

  renderBars("chart-errors", topEntries(t.error_messages, 15).map(([k, v]) => ({ label: k, mono: true, segs: [{ v, c: "var(--s-crashes)" }], text: String(v) })), { long: true });

  const plat = [
    ...topEntries(t.os, 10).map(([k, v]) => ({ label: k, segs: [{ v, c: "var(--s-runs)" }], text: String(v) })),
    ...topEntries(t.versions, 10).map(([k, v]) => ({ label: "v" + k, segs: [{ v, c: "var(--s-players)" }], text: String(v) })),
  ];
  renderBars("chart-platform", plat);
}

// One short token for a tile: 45s, 24.2m, 2.4h.
function fmtShort(s) {
  if (s >= 5400) return (s / 3600).toFixed(1) + "h";
  if (s >= 60) return (s / 60).toFixed(1) + "m";
  return Math.round(s) + "s";
}
function fmtSecs(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.round(s)}s`;
}

function topEntries(obj, limit) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// rows: [{label, segs:[{v, c, title}], text, mono}]
function renderBars(elId, rows, opts = {}) {
  const el = $(elId);
  el.innerHTML = "";
  if (!rows.length) { el.innerHTML = '<div class="nodata">no data in this range.</div>'; return; }
  const max = opts.max || Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.v, 0)));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "bar-row" + (opts.wide ? " wide" : "") + (opts.wideVal ? " wide-val" : "") + (opts.long ? " long" : "");
    const lbl = document.createElement("span");
    lbl.className = "lbl" + (r.mono ? " mono" : ""); lbl.textContent = r.label; lbl.title = r.title || r.label;
    const track = document.createElement("span");
    track.className = "track";
    for (const s of r.segs) {
      if (!s.v) continue;
      const seg = document.createElement("span");
      seg.style.width = (100 * s.v / max).toFixed(2) + "%";
      seg.style.setProperty("--c", s.c);
      seg.title = s.title || `${r.label}: ${s.v}`;
      track.appendChild(seg);
    }
    const val = document.createElement("span");
    val.className = "val"; val.textContent = r.text;
    row.append(lbl, track, val);
    el.appendChild(row);
  }
}

// ============================================================
// Recent runs feed (raw events)
// ============================================================

async function refreshFeed() {
  const day = $("day").value;
  const type = $("type-filter").value;
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  params.set("limit", "45");
  const data = await api("/events?" + params.toString());
  feedEvents = type ? data.events.filter((e) => e.type === type) : data.events;
  feedLimit = FEED_PAGE;
  $("runs-sub").textContent = `${feedEvents.length} events from the latest ${data.file_count} uploads${day ? " on " + day : ""}`;
  renderFeed(feedEvents);
  $("raw").textContent = feedEvents.slice(0, 50).map((e) => JSON.stringify(e)).join("\n");
}

function populateDays() {
  const sel = $("day");
  const keep = sel.value;
  sel.innerHTML = '<option value="">latest</option>' +
    (summaryData.days || []).map((d) => `<option value="${d}">${d}</option>`).join("");
  sel.value = keep;
}

function renderFeed(events) {
  const el = $("feed");
  el.innerHTML = "";
  if (!events.length) { el.innerHTML = '<div class="nodata">no events.</div>'; return; }

  // One group per page load: a session's runs, newest first.
  const groups = new Map();
  for (const e of events) {
    const key = e.session || e.run || "(no session)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const runs = [];
  for (const [run, evs] of groups) {
    evs.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    let lastTime = "";
    for (const e of evs) if ((e.time || "") > lastTime) lastTime = e.time;
    let player = "";
    for (const e of evs) { if (e.install) { player = e.install; break; } }
    runs.push({ run, evs, lastTime, player: player || "?", outcome: runOutcome(evs) });
  }
  const mode = $("sort").value || "recent";
  if (mode === "player") {
    const lastByPlayer = new Map();
    for (const r of runs) {
      const cur = lastByPlayer.get(r.player) || "";
      if (r.lastTime > cur) lastByPlayer.set(r.player, r.lastTime);
    }
    runs.sort((a, b) => {
      const pa = lastByPlayer.get(a.player) || "", pb = lastByPlayer.get(b.player) || "";
      if (pa !== pb) return pb.localeCompare(pa);
      if (a.player !== b.player) return a.player.localeCompare(b.player);
      return b.lastTime.localeCompare(a.lastTime);
    });
  } else {
    runs.sort((a, b) => b.lastTime.localeCompare(a.lastTime));
  }
  for (const r of runs.slice(0, feedLimit)) el.appendChild(runGroup(r));
  if (runs.length > feedLimit) {
    const more = document.createElement("button");
    more.className = "btn ghost small";
    more.textContent = `show ${Math.min(FEED_PAGE, runs.length - feedLimit)} more of ${runs.length} sessions`;
    more.addEventListener("click", () => { feedLimit += FEED_PAGE; renderFeed(events); });
    el.appendChild(more);
  }
}

// evs newest-first. Classify a session from the latest thing it did.
function runOutcome(evs) {
  const last = evs.find((e) => e.type === "run_end" || e.type === "run_start" || e.type === "progress");
  if (last && last.type === "progress") return { text: `run ${last.data?.n ?? "?"} · at L${last.data?.to ?? "?"}`, c: "var(--s-runs)" };
  if (last && last.type === "run_end") return { text: `run ${last.data?.n ?? "?"} ended · L${last.data?.level ?? "?"}`, c: "var(--good)" };
  if (last) return { text: `run ${last.data?.n ?? "?"} begun`, c: "var(--s-runs)" };
  if (evs.some((e) => e.type === "error")) return { text: "error", c: "var(--critical)" };
  return { text: evs[0]?.type === "session_start" ? "opened" : evs[0]?.type || "?", c: "var(--accent)" };
}

function shortId(s) { return s.length > 12 ? s.slice(0, 8) : s; }

// Where the save was when it was last heard from.
function runCharacters(evs) {
  for (const e of evs) {
    const d = e.data || {};
    if (e.type === "progress") continue;
    if (e.type === "run_end") return `deepest L${d.deepest ?? "?"} · ${fmtSecs(Number(d.playtime) || 0)} played`;
    if (e.type === "run_start") return `deepest L${d.deepest ?? "?"} · ${Array.isArray(d.nodes) ? d.nodes.length : "?"} nodes`;
    if (e.type === "session_start") return `run ${d.n ?? "?"} · L${d.level ?? "?"} · deepest L${d.deepest ?? "?"}`;
  }
  return "";
}

function runGroup(r) {
  const det = document.createElement("details");
  det.className = "run";
  const chars = runCharacters(r.evs);
  const ended = r.evs.filter((e) => e.type === "run_end").length, begun = r.evs.filter((e) => e.type === "run_start").length;
  const errs = r.evs.filter((e) => e.type === "error").length;
  const countTxt = [ended && `${ended} run${ended === 1 ? "" : "s"} finished`, begun && `${begun} begun`, errs && `${errs} error${errs === 1 ? "" : "s"}`].filter(Boolean).join(" · ") || "no runs finished";
  const last = (r.lastTime || "").replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  const sum = document.createElement("summary");
  sum.innerHTML = `
    <span class="run-outcome" style="--c:${r.outcome.c}">${escapeHtml(r.outcome.text)}</span>
    <span class="run-main">
      ${chars ? `<span class="run-chars">${escapeHtml(chars)}</span>` : ""}
      <span class="run-meta">${escapeHtml(countTxt)}</span>
      ${r.player !== "?" ? `<span class="run-id" title="player ${escapeHtml(r.player)}">${escapeHtml(shortId(r.player))}</span>` : ""}
    </span>
    <span class="run-time">${escapeHtml(last)}</span>`;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "run-events";
  det.addEventListener("toggle", () => {
    if (det.open && !body.childElementCount) for (const e of r.evs) body.appendChild(eventCard(e));
  }, { once: true });
  det.appendChild(body);
  return det;
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "event event-" + (e.type || "unknown");
  const time = (e.time || "").replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  const tags = [`<span class="tag tag-type">${escapeHtml(e.type || "?")}</span>`];
  if (e.data?.n != null && e.type !== "error") tags.push(`<span class="tag">run ${escapeHtml(e.data.n)}</span>`);
  if (e.type === "run_end" && e.data?.level != null) tags.push(`<span class="tag">L${escapeHtml(e.data.level)}</span>`);
  if (e.type === "progress" && e.data?.to != null) tags.push(`<span class="tag">L${escapeHtml(e.data.to)}</span>`);
  if (e.type === "run_end" && e.data?.first) tags.push(`<span class="tag tag-cleared">new deepest</span>`);
  if (e.data?.fresh) tags.push(`<span class="tag">new save</span>`);
  if (e.os) tags.push(`<span class="tag">${escapeHtml(e.os)}</span>`);
  if (e.version) tags.push(`<span class="tag">v${escapeHtml(e.version)}</span>`);
  div.innerHTML = `<div class="event-head"><span class="time">${escapeHtml(time)}</span>${tags.join(" ")}</div>`;
  const body = document.createElement("div");
  if (e.type === "error") body.appendChild(renderCrashBody(e));
  else if (e.type === "run_end" || e.type === "run_start" || e.type === "session_start" || e.type === "progress") body.appendChild(renderRunBody(e));
  else body.innerHTML = `<pre class="raw">${escapeHtml(JSON.stringify(e.data || {}, null, 2))}</pre>`;
  div.appendChild(body);
  return div;
}

function renderCrashBody(e) {
  const wrap = document.createElement("div");
  const msg = e.data?.message || "";
  const tb = e.data?.stack || "";
  wrap.innerHTML = `<div class="crash-msg">${escapeHtml(msg)}</div>${tb ? `<pre class="trace">${escapeHtml(tb)}</pre>` : ""}`;
  return wrap;
}

function renderRunBody(e) {
  const wrap = document.createElement("div");
  const d = e.data || {};
  const row = (lbl, txt) => (txt ? `<div class="row"><span class="row-lbl">${lbl}</span><span>${escapeHtml(txt)}</span></div>` : "");
  const names = (ids) => (Array.isArray(ids) && ids.length ? ids.map((id) => nodeLabel(String(id))).join(", ") : "");

  const run = [];
  if (e.type === "run_end") {
    if (d.level != null) run.push(`reached level ${d.level}`);
    if (d.secs != null) run.push(fmtSecs(Number(d.secs)));
    if (d.kills != null) run.push(`${d.kills} kills`);
    if (d.fails != null) run.push(`${d.fails} lost fight${d.fails === 1 ? "" : "s"}`);
    if (d.cores != null) run.push(`${d.cores} cores earned`);
  } else if (e.type === "progress") {
    if (d.to != null) run.push(d.from && d.from !== d.to ? `level ${d.from} to ${d.to}` : `at level ${d.to}`);
    if (d.secs != null) run.push(`${fmtSecs(Number(d.secs))} into the run`);
    if (Array.isArray(d.levels) && d.levels.length) run.push(d.levels.filter((p) => Array.isArray(p)).map((p) => `L${p[0]} at ${fmtSecs(Number(p[1]) || 0)}`).join(", "));
    const lost = d.fails && typeof d.fails === "object" ? Object.entries(d.fails).map(([l, n]) => `${n} on L${l}`).join(", ") : "";
    if (lost) run.push(`fights lost: ${lost}`);
  } else if (e.type === "session_start") {
    if (d.level != null) run.push(`at level ${d.level}`);
    if (d.secs != null) run.push(`${fmtSecs(Number(d.secs))} into the run`);
  }

  const line = [];
  if (d.weapons != null) line.push(`${d.weapons} weapon${d.weapons === 1 ? "" : "s"}`);
  if (d.ups != null) line.push(`${d.ups} upgrade ranks`);
  if (d.skills != null) line.push(`${d.skills} skills socketed`);

  const save = [];
  if (d.deepest != null) save.push(`deepest level ${d.deepest}`);
  if (Array.isArray(d.nodes)) save.push(`${d.nodes.length} nodes`); else if (d.nodes != null) save.push(`${d.nodes} nodes`);
  if (d.cores != null && e.type !== "run_end") save.push(`${d.cores} cores banked`);
  if (d.playtime != null) save.push(`played ${fmtSecs(Number(d.playtime))}`);

  const did = d.counts && typeof d.counts === "object"
    ? Object.entries(d.counts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ") : "";

  wrap.innerHTML = row("run", run.join(" · ")) + row("line", line.join(" · ")) + row("did", did) +
    row("bought", names(d.bought)) + row("unspecced", names(d.dropped)) + row("save", save.join(" · "));
  return wrap;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  for (const b of document.querySelectorAll(".range button")) {
    b.classList.toggle("active", Number(b.dataset.range) === rangeDays);
    b.addEventListener("click", () => {
      rangeDays = Number(b.dataset.range);
      localStorage.setItem(LS_RANGE, String(rangeDays));
      for (const o of document.querySelectorAll(".range button")) o.classList.toggle("active", o === b);
      if (summaryData) renderHistory();
    });
  }
  $("refresh").addEventListener("click", () => { populateDaysSafe(); refresh(); });
  $("save").addEventListener("click", () => { saveCreds(); toggleSettings(false); refresh(); });
  $("logout").addEventListener("click", clearCreds);
  $("settings-toggle").addEventListener("click", () => toggleSettings());
  $("token").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("save").click(); });

  $("day").addEventListener("change", () => refreshFeed().catch((e) => setStatus(e.message, true)));
  $("type-filter").addEventListener("change", () => refreshFeed().catch((e) => setStatus(e.message, true)));
  $("sort").addEventListener("change", () => renderFeed(feedEvents));
  $("activity-table-toggle").addEventListener("click", (ev) => {
    const on = $("activity-table").hidden;
    $("activity-table").hidden = !on;
    $("activity-chart").hidden = on;
    ev.currentTarget.setAttribute("aria-pressed", String(on));
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (summaryData && !$("activity-chart").hidden) drawLineChart($("activity-chart"), activityRows, SERIES); }, 120);
  });

  if (hasCreds()) refresh().then(populateDaysSafe);
  else toggleSettings(true);
});

function populateDaysSafe() { if (summaryData) populateDays(); }
