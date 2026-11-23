/**
 * Smeltworks Idle telemetry worker.
 *
 *   POST /ingest      open. accepts NDJSON, one event per line. writes to R2.
 *   GET  /events      Bearer-token-protected. lists/reads NDJSON files.
 *   GET  /events?day=YYYY-MM-DD&limit=N
 *   GET  /days        auth. list of receipt days that have event files.
 *   GET  /summary     auth. merged per-day rollups (summary/all.json) + days.
 *   POST /rollup?day=YYYY-MM-DD   auth. roll up (one batch of) a day's files
 *                                 into summary/<day>.json and summary/all.json.
 *
 * The ingest endpoint is open because that's what the game POSTs to from
 * every browser that plays it — there's no way to keep that URL secret. The
 * read endpoints are gated by DASHBOARD_TOKEN (set via `wrangler secret put`).
 *
 * The game posts with Content-Type text/plain so the browser sends no CORS
 * preflight; the body is NDJSON all the same.
 *
 * Storage layout (R2):
 *   events/<receipt-day>/<iso-time>-<uuid>.ndjson   raw uploads, immutable
 *   summary/<receipt-day>.json                      DaySummary (with cursor)
 *   summary/all.json                                AllSummary (counts only)
 *
 * Why rollups exist: a single invocation may only open ~50 subrequests on the
 * free plan, so the dashboard can never read more than ~45 raw files per call.
 * Rollups fold each day's files into a small JSON once, incrementally, so a
 * full history chart is one small read.
 */

export interface WorkerEnv {
	BUCKET: R2Bucket;
	DASHBOARD_TOKEN: string;
}

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const MAX_BODY_BYTES = 200_000;     // per POST
const MAX_LIST_KEYS = 1000;          // per /events response
// Each file read is a subrequest. The Workers free plan caps subrequests at
// 50 per invocation (1000 on paid); stay under the free limit so a large
// bucket can't blow up the read with "Too many subrequests".
const MAX_READ_FILES = 45;           // per /events response
// Rollup budget: get day file + list + N reads + get all.json + 2 puts <= 45.
const ROLLUP_BATCH_FILES = 38;
// R2 .get() opens a stream; Workers caps concurrently open streams (~6).
const CONCURRENCY = 6;

// Bump when DateMetrics changes shape: stale day files are rebuilt from raw
// events and every day in all.json is marked incomplete so the dashboard
// re-rolls them.
const SUMMARY_VERSION = 2;
const ALL_KEY = "summary/all.json";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS },
	});
}

function text(body: string, status = 200, contentType = "text/plain"): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": contentType, ...CORS },
	});
}

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function isDay(s: string | null): s is string {
	return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ============================================================
// Ingest
// ============================================================

async function ingest(req: Request, env: WorkerEnv): Promise<Response> {
	if (req.method !== "POST") return text("method not allowed", 405);

	const contentLength = Number(req.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) return text("payload too large", 413);

	const body = await req.text();
	if (body.length === 0) return text("empty body", 400);
	if (body.length > MAX_BODY_BYTES) return text("payload too large", 413);

	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	// Time-prefixed keys sort chronologically, which lets rollups resume from a
	// cursor (list startAfter) and pick up only files that arrived since —
	// including for the current day. Older files are bare UUIDs; those days are
	// immutable so cursor order doesn't matter for them.
	const stamp = now.toISOString().slice(11, 23).replace(/:/g, "-"); // HH-MM-SS.mmm
	const id = crypto.randomUUID();
	const key = `events/${day}/${stamp}-${id}.ndjson`;

	// Nothing about the request itself is kept: no address, no country, no headers.
	await env.BUCKET.put(key, body, {
		httpMetadata: { contentType: "application/x-ndjson" },
	});

	return text("ok");
}

// ============================================================
// Auth
// ============================================================

function unauthorized(): Response {
	return new Response("unauthorized", {
		status: 401,
		headers: { ...CORS, "WWW-Authenticate": 'Bearer realm="smeltworks-idle"' },
	});
}

function authOk(req: Request, env: WorkerEnv): boolean {
	if (!env.DASHBOARD_TOKEN) return false;
	const header = req.headers.get("authorization") || "";
	const m = header.match(/^Bearer\s+(.+)$/i);
	if (!m) return false;
	// constant-time-ish compare
	const a = m[1];
	const b = env.DASHBOARD_TOKEN;
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ============================================================
// Raw reads
// ============================================================

// Read a set of keys in bounded batches, returning parsed events.
async function readEvents(env: WorkerEnv, keys: string[]): Promise<any[]> {
	const events: any[] = [];
	for (let i = 0; i < keys.length; i += CONCURRENCY) {
		const batch = keys.slice(i, i + CONCURRENCY);
		const bodies = await Promise.all(
			batch.map(async (k) => {
				try {
					const obj = await env.BUCKET.get(k);
					return obj ? await obj.text() : null;
				} catch {
					return null; // skip a single unreadable object
				}
			}),
		);
		for (const body of bodies) {
			if (!body) continue;
			for (const line of body.split("\n")) {
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line));
				} catch {
					// drop malformed lines silently
				}
			}
		}
	}
	return events;
}

async function listEvents(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();

	const url = new URL(req.url);
	const day = url.searchParams.get("day"); // YYYY-MM-DD or omitted = recent
	const limit = Math.min(Number(url.searchParams.get("limit") || MAX_READ_FILES), MAX_READ_FILES);

	const prefix = day ? `events/${day}/` : "events/";

	const listing = await env.BUCKET.list({ prefix, limit: MAX_LIST_KEYS });
	// Keys are day-prefixed (and time-prefixed since the rollup change), so a
	// descending sort is newest-first.
	const keys = listing.objects.map((o) => o.key).sort().reverse().slice(0, limit);
	const events = await readEvents(env, keys);

	return json({
		days: day ? [day] : undefined,
		file_count: keys.length,
		event_count: events.length,
		truncated: listing.truncated,
		events,
	});
}

async function listDayPrefixes(env: WorkerEnv): Promise<string[]> {
	const listing = await env.BUCKET.list({ prefix: "events/", delimiter: "/", limit: 1000 });
	return (listing.delimitedPrefixes || [])
		.map((p) => p.replace(/^events\//, "").replace(/\/$/, ""))
		.filter(Boolean)
		.sort()
		.reverse();
}

async function listDays(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	return json({ days: await listDayPrefixes(env) });
}

// ============================================================
// Rollups
// ============================================================

type Counts = Record<string, number>;

// Per event-date (client `time`, clamped to the receipt day) metrics.
//
// Every number here is a count or a sum, never an average or a maximum, so
// days (and the receipt-day files they are split across) can be added together.
// The dashboard divides: an average is a sum over the count beside it.
export interface DateMetrics {
	events: number;
	runs: number;          // distinct run ids seen on this date (set size)
	installs: number;      // distinct installs seen on this date (set size)
	sessions: number;      // session_start events (page loads)
	new_players: number;   // session_start with data.fresh (a save with no run and no kill yet)
	errors: number;
	run_starts: number;    // a run begun from the prestige tree
	run_ends: number;      // a run ended by prestige
	new_deepest: number;   // run_end that reached a level the save had never reached
	secs: number;          // sum of run length over run_end (game seconds)
	levels: number;        // sum of the deepest level each run reached
	kills: number;
	fails: number;         // fights lost
	cores: number;         // cores earned
	weapons: number;       // weapons equipped when the run ended
	ups: number;           // upgrade ranks on them
	skills: number;        // skills socketed in them
	ends_by_level: Counts;     // run_end count by the deepest level the run reached
	ends_by_run: Counts;       // run_end count by run number (the denominator for the three sums below)
	secs_by_run: Counts;       // sum of run length, by run number
	level_by_run: Counts;      // sum of deepest level, by run number
	cores_by_run: Counts;      // sum of cores earned, by run number
	starts_by_run: Counts;     // run_start count by run number
	nodes_by_run: Counts;      // sum of nodes held when the run began, by run number
	nodes_held: Counts;        // node id -> run_starts that held it
	nodes_bought: Counts;      // node id -> times bought
	nodes_dropped: Counts;     // node id -> times handed back (unspec)
	node_buy_run: Counts;      // node id -> sum of the run number it was bought for (over nodes_bought: when it is bought)
	progress: number;          // progress events (how far a run has got, sent every couple of minutes at most)
	// Where runs are: level -> runs whose deepest level, as last reported, is that one. A progress event adds one at
	// the level it has reached and takes one away at the level it last reported, so over a whole history each run
	// is counted once, where it was last heard from. Less ends_by_level, that is the runs that stopped there
	// without a prestige (or are still going). Over a short range it can be negative: the dashboard clamps it.
	open_at: Counts;
	reach_n: Counts;           // level -> runs that reached it (and said when)
	reach_secs: Counts;        // level -> sum of the run's game time when it was reached
	fails_by_level: Counts;    // level -> fights lost on it
	counts: Counts;            // what was done in a run, summed from run_end data.counts: forged, scrapped, reroll_type, craft_add ...
	os: Counts;
	versions: Counts;
	error_messages: Counts;
}

export interface DaySummary {
	version: number;
	day: string;               // receipt day
	updated: string;
	cursor: string;            // last key folded in (list startAfter)
	files: number;
	complete: boolean;         // true once a *past* day has no more files
	// Keys already folded whose time is within CURSOR_SLACK_MS of the cursor: see rollupDay.
	recent?: string[];
	dates: Record<string, DateMetrics>;
	// Identity sets, kept only in the day file so a resumed rollup can dedupe.
	sets: Record<string, { runs: string[]; installs: string[] }>;
}

interface AllSummary {
	version: number;
	updated: string;
	days: Record<string, { updated: string; files: number; complete: boolean; dates: Record<string, DateMetrics> }>;
}

export function emptyMetrics(): DateMetrics {
	return {
		events: 0, runs: 0, installs: 0, sessions: 0, new_players: 0, errors: 0,
		run_starts: 0, run_ends: 0, new_deepest: 0, secs: 0, levels: 0, kills: 0, fails: 0, cores: 0, weapons: 0, ups: 0, skills: 0,
		ends_by_level: {}, ends_by_run: {}, secs_by_run: {}, level_by_run: {}, cores_by_run: {}, starts_by_run: {}, nodes_by_run: {},
		nodes_held: {}, nodes_bought: {}, nodes_dropped: {}, node_buy_run: {},
		progress: 0, open_at: {}, reach_n: {}, reach_secs: {}, fails_by_level: {},
		counts: {}, os: {}, versions: {}, error_messages: {},
	};
}

// A finite number from 0 to max, or 0. Client data is untrusted: never let NaN, a string or an absurd value into
// a sum (one made-up 1e99 clamped to the maximum would still wreck an average, so it counts for nothing instead).
function num(v: unknown, max = 1e9): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : 0;
}

// Runs are numbered from 1 on each save. Everything from the 60th on shares one bucket.
export const RUN_CAP = 60;
export function runKey(n: unknown): number | null {
	return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100_000 ? Math.min(RUN_CAP, n) : null;
}

// The deepest level a run reached. Levels have no end, so past 500 they share one bucket.
export const LEVEL_CAP = 500;
export function levelKey(lv: unknown): number | null {
	return typeof lv === "number" && Number.isInteger(lv) && lv >= 1 && lv <= 1_000_000 ? Math.min(LEVEL_CAP, lv) : null;
}

// Node ids of the game's prestige tree are short and plain (F1, UPG, wu4): anything else is dropped.
function nodeIds(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v.slice(0, 300)) if (typeof x === "string" && /^[A-Za-z0-9_]{1,10}$/.test(x) && !out.includes(x)) out.push(x);
	return out;
}

function bump(c: Counts, key: unknown, n = 1) {
	if (key == null || key === "") return;
	const k = String(key);
	c[k] = (c[k] || 0) + n;
}

// Which date bucket an event belongs to: its own `time` if sane, else the
// receipt day. Client clocks ahead of the server are clamped to receipt day.
function eventDate(e: any, receiptDay: string): string {
	const t = typeof e.time === "string" ? e.time.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return receiptDay;
	if (t > receiptDay) return receiptDay;
	return t;
}

export function foldEvent(sum: DaySummary, e: any) {
	if (!e || typeof e !== "object" || e.game !== "SMELTWORKS_IDLE") return;   // not ours: ignore
	const date = eventDate(e, sum.day);
	const m = (sum.dates[date] ||= emptyMetrics());
	const sets = (sum.sets[date] ||= { runs: [], installs: [] });
	m.events++;
	const install = typeof e.install === "string" ? e.install.slice(0, 64) : "";
	if (install && !sets.installs.includes(install)) sets.installs.push(install);
	const run = typeof e.run === "string" ? e.run.slice(0, 64) : "";
	bump(m.os, String(e.os || "").slice(0, 20));
	bump(m.versions, String(e.version || "").slice(0, 20));
	const d = e.data || {};
	if (e.type === "error") {
		m.errors++;
		const msg = String(d.message || "").split("\n")[0].slice(0, 120);
		bump(m.error_messages, msg || "(no message)");
	} else if (e.type === "session_start") {
		m.sessions++;
		if (d.fresh === true) m.new_players++;
	} else if (e.type === "run_start") {
		// what the prestige tree held as the run began, and what that visit to it changed
		if (run && !sets.runs.includes(run)) sets.runs.push(run);
		m.run_starts++;
		const rn = runKey(d.n), held = nodeIds(d.nodes);
		bump(m.starts_by_run, rn);
		bump(m.nodes_by_run, rn, held.length);
		for (const id of held) bump(m.nodes_held, id);
		for (const id of nodeIds(d.bought)) { bump(m.nodes_bought, id); bump(m.node_buy_run, id, rn ?? 0); }
		for (const id of nodeIds(d.dropped)) bump(m.nodes_dropped, id);
	} else if (e.type === "progress") {
		// how far the run has got: it moves from the level it last reported to the one it is on now
		if (run && !sets.runs.includes(run)) sets.runs.push(run);
		m.progress++;
		const to = levelKey(d.to), from = levelKey(d.from);
		if (to != null && to !== from) { bump(m.open_at, to); if (from != null) bump(m.open_at, from, -1); }
		if (Array.isArray(d.levels)) {
			for (const pair of d.levels.slice(0, 300)) {
				const lv = Array.isArray(pair) ? levelKey(pair[0]) : null;
				if (lv != null) { bump(m.reach_n, lv); bump(m.reach_secs, lv, num(pair[1], 2_592_000)); }
			}
		}
		if (d.fails && typeof d.fails === "object" && !Array.isArray(d.fails)) {
			for (const [k, v] of Object.entries(d.fails).slice(0, 100)) { const lv = levelKey(Number(k)); if (lv != null) bump(m.fails_by_level, lv, num(v, 10_000)); }
		}
	} else if (e.type === "run_end") {
		if (run && !sets.runs.includes(run)) sets.runs.push(run);
		const rn = runKey(d.n), lv = levelKey(d.level);
		m.run_ends++;
		m.secs += num(d.secs, 2_592_000);
		m.levels += lv ?? 0;
		m.kills += num(d.kills, 10_000_000);
		m.fails += num(d.fails, 100_000);
		m.cores += num(d.cores, 1_000_000);
		m.weapons += num(d.weapons, 6);
		m.ups += num(d.ups, 150);
		m.skills += num(d.skills, 36);
		if (d.first === true) m.new_deepest++;
		bump(m.ends_by_level, lv);
		bump(m.ends_by_run, rn);
		bump(m.secs_by_run, rn, num(d.secs, 2_592_000));
		bump(m.level_by_run, rn, lv ?? 0);
		bump(m.cores_by_run, rn, num(d.cores, 1_000_000));
		if (d.counts && typeof d.counts === "object") {
			for (const [k, v] of Object.entries(d.counts).slice(0, 40)) if (/^[a-z0-9_]{1,32}$/.test(k)) bump(m.counts, k, num(v, 1_000_000));
		}
	}
}

function finalizeSets(sum: DaySummary) {
	for (const [date, s] of Object.entries(sum.sets)) {
		const m = (sum.dates[date] ||= emptyMetrics());
		m.runs = s.runs.length;
		m.installs = s.installs.length;
	}
}

// How far behind the cursor a late key may still turn up and be folded.
const CURSOR_SLACK_MS = 5000;
// The key to list after: CURSOR_SLACK_MS before the cursor's time. "" for the start of the day.
function slackKey(prefix: string, cursor: string): string {
	const m = cursor.slice(prefix.length).match(/^(\d{2})-(\d{2})-(\d{2})\.(\d{3})-/);
	if (!cursor.startsWith(prefix) || !m) return cursor;      // not a time-stamped key: nothing to allow for
	const ms = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] - CURSOR_SLACK_MS;
	if (ms <= 0) return "";
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${prefix}${p(Math.floor(ms / 3_600_000))}-${p(Math.floor(ms / 60_000) % 60)}-${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

async function getJson<T>(env: WorkerEnv, key: string): Promise<T | null> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return null;
	try { return (await obj.json()) as T; } catch { return null; }
}

// One batch of rollup work for `day`. Returns the updated day summary and
// whether more files remain.
async function rollupDay(env: WorkerEnv, day: string): Promise<{ summary: DaySummary; remaining: boolean; read: number }> {
	const dayKey = `summary/${day}.json`;
	let sum = await getJson<DaySummary>(env, dayKey);
	if (!sum || sum.version !== SUMMARY_VERSION) {
		sum = { version: SUMMARY_VERSION, day, updated: "", cursor: "", files: 0, complete: false, dates: {}, sets: {} };
	}

	// Keys are <time>-<uuid>, and two uploads can share a millisecond (or come from machines whose clocks differ
	// by a few), so a file can be written with a key that sorts *before* one already folded. Resuming strictly
	// after the cursor would skip it for good. Instead each batch lists from a little before the cursor and
	// leaves out the keys it has already folded there (`recent`).
	const prefix = `events/${day}/`;
	const seen = new Set(sum.recent || []);
	const listing = await env.BUCKET.list({
		prefix,
		limit: Math.min(MAX_LIST_KEYS, ROLLUP_BATCH_FILES + seen.size),
		startAfter: slackKey(prefix, sum.cursor) || undefined,
	});
	const fresh = listing.objects.map((o) => o.key).filter((k) => !seen.has(k)).sort();
	const keys = fresh.slice(0, ROLLUP_BATCH_FILES);
	const events = await readEvents(env, keys);
	for (const e of events) foldEvent(sum, e);
	finalizeSets(sum);

	sum.files += keys.length;
	if (keys.length && keys[keys.length - 1] > sum.cursor) sum.cursor = keys[keys.length - 1];
	const floor = slackKey(prefix, sum.cursor);
	sum.recent = [...seen, ...keys].filter((k) => k > floor).sort();
	const remaining = listing.truncated || fresh.length > keys.length;
	// A past day never gains files, so "no more to list" means done for good.
	// Today is never complete: the next rollup resumes from the cursor.
	sum.complete = !remaining && day < todayUTC();
	sum.updated = new Date().toISOString();

	await env.BUCKET.put(dayKey, JSON.stringify(sum), {
		httpMetadata: { contentType: "application/json" },
	});

	// Merge into all.json (counts only; identity sets stay in the day file).
	const all = (await getJson<AllSummary>(env, ALL_KEY)) || { version: SUMMARY_VERSION, updated: "", days: {} };
	if (all.version !== SUMMARY_VERSION) {
		// Shape changed: keep old numbers visible but flag every day for a re-roll.
		for (const d of Object.values(all.days)) d.complete = false;
	}
	all.version = SUMMARY_VERSION;
	all.updated = sum.updated;
	all.days[day] = { updated: sum.updated, files: sum.files, complete: sum.complete, dates: sum.dates };
	await env.BUCKET.put(ALL_KEY, JSON.stringify(all), {
		httpMetadata: { contentType: "application/json" },
	});

	return { summary: sum, remaining, read: keys.length };
}

async function rollup(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	if (req.method !== "POST") return text("method not allowed", 405);
	const day = new URL(req.url).searchParams.get("day");
	if (!isDay(day)) return text("day=YYYY-MM-DD required", 400);
	if (day > todayUTC()) return text("day is in the future", 400);
	const { summary, remaining, read } = await rollupDay(env, day);
	return json({
		day,
		files_read: read,
		files_total: summary.files,
		complete: summary.complete,
		remaining,
		cursor: summary.cursor,
	});
}

async function summary(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	const [days, all] = await Promise.all([listDayPrefixes(env), getJson<AllSummary>(env, ALL_KEY)]);
	if (all && all.version !== SUMMARY_VERSION) {
		for (const d of Object.values(all.days)) d.complete = false;
	}
	return json({
		today: todayUTC(),
		days,
		all: all || { version: SUMMARY_VERSION, updated: "", days: {} },
	});
}

// Hourly cron: fold today's new files, and finish yesterday if it isn't
// complete yet (one batch each — the dashboard backfills anything older).
async function scheduledRollup(env: WorkerEnv) {
	const today = todayUTC();
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	const y = await getJson<DaySummary>(env, `summary/${yesterday}.json`);
	if (!y || !y.complete) await rollupDay(env, yesterday);
	await rollupDay(env, today);
}

// ============================================================
// Router
// ============================================================

export default {
	async fetch(req: Request, env: WorkerEnv): Promise<Response> {
		if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

		try {
			const url = new URL(req.url);

			if (url.pathname === "/ingest") return await ingest(req, env);
			if (url.pathname === "/events") return await listEvents(req, env);
			if (url.pathname === "/days") return await listDays(req, env);
			if (url.pathname === "/summary") return await summary(req, env);
			if (url.pathname === "/rollup") return await rollup(req, env);
			if (url.pathname === "/" || url.pathname === "/health") {
				return text("Smeltworks Idle telemetry worker. POST /ingest, GET /events (auth), GET /days (auth), GET /summary (auth), POST /rollup?day= (auth).");
			}

			return text("not found", 404);
		} catch (e: any) {
			// Always return CORS headers, even on failure — otherwise the browser
			// reports a generic CORS error and the real cause is invisible.
			return text("worker error: " + (e?.message || String(e)), 500);
		}
	},

	async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
		ctx.waitUntil(scheduledRollup(env));
	},
} satisfies ExportedHandler<WorkerEnv>;
