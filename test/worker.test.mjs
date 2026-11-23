// Runs the worker against an in-memory stand-in for the R2 bucket: `npm test` (Node 22.18+, no install needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { levelKey, runKey, LEVEL_CAP, RUN_CAP } from "../src/index.ts";

const TOKEN = "test-token";
const auth = { Authorization: "Bearer " + TOKEN };

function fakeBucket() {
	const store = new Map();
	return {
		store,
		async put(key, body) { store.set(key, String(body)); },
		async get(key) { if (!store.has(key)) return null; const v = store.get(key); return { text: async () => v, json: async () => JSON.parse(v) }; },
		async list({ prefix = "", limit = 1000, startAfter, delimiter } = {}) {
			let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			if (delimiter) {
				const pre = new Set();
				for (const k of keys) { const rest = k.slice(prefix.length), i = rest.indexOf(delimiter); if (i >= 0) pre.add(prefix + rest.slice(0, i + 1)); }
				return { objects: [], delimitedPrefixes: [...pre], truncated: false };
			}
			if (startAfter) keys = keys.filter((k) => k > startAfter);
			return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit };
		},
	};
}
const mkEnv = () => ({ BUCKET: fakeBucket(), DASHBOARD_TOKEN: TOKEN });
const call = (env, path, init) => worker.fetch(new Request("https://x" + path, init), env);
const ev = (type, o = {}, data = {}) => JSON.stringify({ type, game: "SMELTWORKS_IDLE", version: "0.84.0", install: "i1", session: "s1", run: "r1", time: "2025-03-02T10:00:00Z", host: "sdwr.github.io", os: "Windows", ...o, data });
const runStart = (run, n, data = {}, o = {}) => ev("run_start", { run, ...o }, { n, deepest: 1, cores: 0, nodes: ["F1"], bought: [], dropped: [], playtime: 0, ...data });
const runEnd = (run, n, level, data = {}, o = {}) => ev("run_end", { run, ...o }, { n, level, secs: 100, kills: 10, fails: 1, cores: 5, first: false, weapons: 1, ups: 0, skills: 1, deepest: level, playtime: 100, counts: {}, ...data });

test("run and level keys: whole numbers from 1, with one bucket for everything past the cap", () => {
	assert.equal(levelKey(1), 1); assert.equal(levelKey(37), 37); assert.equal(levelKey(LEVEL_CAP + 40), LEVEL_CAP);
	assert.equal(levelKey(0), null); assert.equal(levelKey(2.5), null); assert.equal(levelKey("7"), null); assert.equal(levelKey(undefined), null); assert.equal(levelKey(1e12), null);
	assert.equal(runKey(1), 1); assert.equal(runKey(RUN_CAP + 3), RUN_CAP); assert.equal(runKey(0), null); assert.equal(runKey(-2), null); assert.equal(runKey("3"), null);
});

test("ingest is open, takes text/plain NDJSON, answers preflight, and keeps nothing about the request", async () => {
	const env = mkEnv();
	const pre = await call(env, "/ingest", { method: "OPTIONS" }); assert.equal(pre.headers.get("access-control-allow-origin"), "*");
	const res = await call(env, "/ingest", { method: "POST", headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "203.0.113.9" }, body: ev("session_start") + "\n" });
	assert.equal(res.status, 200); assert.equal(res.headers.get("access-control-allow-origin"), "*");
	const day = new Date().toISOString().slice(0, 10), keys = [...env.BUCKET.store.keys()];
	assert.equal(keys.length, 1); assert.match(keys[0], new RegExp(`^events/${day}/\\d{2}-\\d{2}-\\d{2}\\.\\d{3}-[0-9a-f-]{36}\\.ndjson$`));
	assert.ok(!/203\.0\.113/.test(JSON.stringify([...env.BUCKET.store.entries()])), "no address is stored");
	assert.equal((await call(env, "/ingest", { method: "POST", body: "" })).status, 400);
	assert.equal((await call(env, "/ingest", { method: "GET" })).status, 405);
	assert.equal((await call(env, "/ingest", { method: "POST", body: "x".repeat(200_001) })).status, 413);
});

test("reads need the token", async () => {
	const env = mkEnv();
	for (const p of ["/summary", "/events", "/days"]) assert.equal((await call(env, p)).status, 401, p);
	assert.equal((await call(env, "/rollup?day=2025-03-02", { method: "POST" })).status, 401);
	assert.equal((await call(env, "/summary", { headers: { Authorization: "Bearer wrong-token" } })).status, 401);
	assert.equal((await call(env, "/summary", { headers: auth })).status, 200);
	assert.equal((await call({ BUCKET: fakeBucket(), DASHBOARD_TOKEN: "" }, "/summary", { headers: { Authorization: "Bearer " } })).status, 401, "no token configured means no reads at all");
});

test("rollup folds a day's runs: how long, how deep, which nodes, and what was done at the forge", async () => {
	const env = mkEnv(), day = "2025-03-02", two = { install: "i2", session: "s2" };
	const lines = [
		ev("session_start", {}, { n: 1, fresh: true }),
		ev("session_start", two, { n: 4, fresh: false }),
		runStart("r1", 1, { nodes: ["F1"], bought: ["F1"] }),
		runEnd("r1", 1, 2, { secs: 60, kills: 12, fails: 1, cores: 1, first: true, weapons: 1, skills: 0, counts: { forged: 1, equipped: 1 } }),
		runStart("r2", 2, { nodes: ["F1", "F2"], bought: ["F2"] }),
		runEnd("r2", 2, 6, { secs: 900, kills: 200, fails: 3, cores: 9, first: true, weapons: 1, ups: 0, skills: 1, counts: { forged: 3, equipped: 2, scrapped: 1, reroll_type: 2, reroll_sockets: 1, craft_add: 4, craft_strip: 1, market: 6, salvage: 9, drops: 14 } }),
		runStart("r7", 4, { nodes: ["F1", "F2", "UPG", "P1"], bought: ["UPG", "P1"], dropped: ["w1"] }, two),
		runEnd("r7", 4, 6, { secs: 1200, kills: 300, fails: 0, cores: 9, weapons: 2, ups: 5, skills: 2, counts: { forged: 2, equipped: 2, upgrade: 3, upgrade_ranks: 5 } }, two),
		runEnd("r7", 4, 6, { secs: 1200, kills: 300, fails: 0, cores: 9, weapons: 2, ups: 5, skills: 2, counts: { forged: 2, equipped: 2, upgrade: 3, upgrade_ranks: 5 } }, two),      // the same run posted twice still counts once as a run
		ev("error", {}, { message: "TypeError: x is not a function\nsecond line", stack: "at ui.js:10:5" }),
		JSON.stringify({ type: "run_end", game: "SMELTWORKS", run: "zz", install: "zz", time: "2025-03-02T10:00:00Z", data: { n: 1, level: 3 } }),      // the other game's event
		"not json at all",
		runEnd("r9", "many", "deep", { secs: -5, kills: 1e99, fails: "x", cores: null, counts: { forged: "lots", "bad key!": 3, salvage: 2 } }, { time: "2025-03-01T23:59:00Z" }),      // nonsense values, and played the day before
		runStart("r9", 1, { nodes: ["F1", "F1", 42, "<script>", "way_too_long_for_a_node_id"], bought: "F1", dropped: null }, { time: "2025-03-01T23:50:00Z" }),
	];
	env.BUCKET.store.set(`events/${day}/10-00-00.000-a.ndjson`, lines.slice(0, 6).join("\n"));
	env.BUCKET.store.set(`events/${day}/10-05-00.000-b.ndjson`, lines.slice(6).join("\n") + "\n");
	const r = await (await call(env, "/rollup?day=" + day, { method: "POST", headers: auth })).json();
	assert.equal(r.files_read, 2); assert.equal(r.remaining, false); assert.equal(r.complete, true, "a past day with nothing left is done for good");
	const s = await (await call(env, "/summary", { headers: auth })).json();
	assert.deepEqual(s.days, [day]);
	const m = s.all.days[day].dates[day], prev = s.all.days[day].dates["2025-03-01"];
	assert.equal(m.sessions, 2); assert.equal(m.new_players, 1); assert.equal(m.installs, 2); assert.equal(m.errors, 1);
	assert.equal(m.runs, 3, "three distinct runs"); assert.equal(m.run_starts, 3); assert.equal(m.run_ends, 4); assert.equal(m.new_deepest, 2);
	// how long and how deep
	assert.equal(m.secs, 60 + 900 + 1200 + 1200); assert.equal(m.levels, 2 + 6 + 6 + 6); assert.equal(m.kills, 812); assert.equal(m.fails, 4); assert.equal(m.cores, 28);
	assert.deepEqual(m.ends_by_level, { 2: 1, 6: 3 }); assert.deepEqual(m.ends_by_run, { 1: 1, 2: 1, 4: 2 });
	assert.deepEqual(m.secs_by_run, { 1: 60, 2: 900, 4: 2400 }); assert.deepEqual(m.level_by_run, { 1: 2, 2: 6, 4: 12 }); assert.deepEqual(m.cores_by_run, { 1: 1, 2: 9, 4: 18 });
	assert.equal(m.weapons, 6); assert.equal(m.ups, 10); assert.equal(m.skills, 5);
	// which nodes
	assert.deepEqual(m.starts_by_run, { 1: 1, 2: 1, 4: 1 }); assert.deepEqual(m.nodes_by_run, { 1: 1, 2: 2, 4: 4 });
	assert.deepEqual(m.nodes_held, { F1: 3, F2: 2, UPG: 1, P1: 1 }); assert.deepEqual(m.nodes_bought, { F1: 1, F2: 1, UPG: 1, P1: 1 }); assert.deepEqual(m.nodes_dropped, { w1: 1 });
	assert.deepEqual(m.node_buy_run, { F1: 1, F2: 2, UPG: 4, P1: 4 });
	// what was done
	assert.deepEqual(m.counts, { forged: 8, equipped: 7, scrapped: 1, reroll_type: 2, reroll_sockets: 1, craft_add: 4, craft_strip: 1, market: 6, salvage: 9, drops: 14, upgrade: 6, upgrade_ranks: 10 });
	assert.deepEqual(m.error_messages, { "TypeError: x is not a function": 1 }); assert.deepEqual(m.versions, { "0.84.0": m.events });
	assert.equal(m.os.Windows, m.events); assert.equal(m.events, 10, "the other game's event and the broken line are not counted");
	// the run played the day before lands on its own date, with nonsense clamped to nothing
	assert.equal(prev.run_ends, 1); assert.equal(prev.run_starts, 1); assert.equal(prev.runs, 1); assert.equal(prev.secs, 0); assert.equal(prev.levels, 0); assert.equal(prev.fails, 0); assert.equal(prev.cores, 0); assert.equal(prev.kills, 0);
	assert.deepEqual(prev.ends_by_level, {}); assert.deepEqual(prev.ends_by_run, {}); assert.deepEqual(prev.counts, { forged: 0, salvage: 2 });
	assert.deepEqual(prev.nodes_held, { F1: 1 }, "ids are deduplicated, and anything that is not a plain short id is dropped"); assert.deepEqual(prev.nodes_bought, {}); assert.deepEqual(prev.nodes_dropped, {});
	// rolling up again reads nothing new and changes nothing
	const again = await (await call(env, "/rollup?day=" + day, { method: "POST", headers: auth })).json(); assert.equal(again.files_read, 0);
	const s2 = await (await call(env, "/summary", { headers: auth })).json(); assert.deepEqual(s2.all.days[day].dates, s.all.days[day].dates);
	// raw events come back for the feed
	const feed = await (await call(env, "/events?day=" + day, { headers: auth })).json(); assert.equal(feed.file_count, 2); assert.equal(feed.event_count, 13);
});

test("a big day is rolled up in batches from a cursor, and today is never complete", async () => {
	const env = mkEnv(), day = "2025-03-03";
	for (let i = 0; i < 50; i++) env.BUCKET.store.set(`events/${day}/10-00-${String(i).padStart(2, "0")}.000-x.ndjson`, runEnd("run" + i, 1, 3, {}, { time: day + "T12:00:00Z" }));
	const a = await (await call(env, "/rollup?day=" + day, { method: "POST", headers: auth })).json(); assert.equal(a.files_read, 38); assert.equal(a.remaining, true); assert.equal(a.complete, false);
	const b = await (await call(env, "/rollup?day=" + day, { method: "POST", headers: auth })).json(); assert.equal(b.files_read, 12); assert.equal(b.remaining, false); assert.equal(b.complete, true);
	const s = await (await call(env, "/summary", { headers: auth })).json(); assert.equal(s.all.days[day].dates[day].runs, 50); assert.equal(s.all.days[day].dates[day].run_ends, 50); assert.deepEqual(s.all.days[day].dates[day].ends_by_level, { 3: 50 });
	const today = new Date().toISOString().slice(0, 10), now = { time: new Date().toISOString() };
	await call(env, "/ingest", { method: "POST", body: runEnd("t1", 2, 9, {}, now) });
	const t = await (await call(env, "/rollup?day=" + today, { method: "POST", headers: auth })).json(); assert.equal(t.files_read, 1); assert.equal(t.complete, false);
	assert.equal((await call(env, "/rollup?day=2999-01-01", { method: "POST", headers: auth })).status, 400);
	// the hourly cron does the same without being asked
	await call(env, "/ingest", { method: "POST", body: runEnd("t2", 3, 9, {}, now) });
	let waited; await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } }); await waited;
	const s2 = await (await call(env, "/summary", { headers: auth })).json(); assert.equal(s2.all.days[today].dates[today].run_ends, 2);
});

test("an upload whose key sorts before the cursor is still folded: same millisecond, or a clock a little behind", async () => {
	const env = mkEnv(), day = "2025-03-04", at = { time: day + "T12:00:00Z" };
	const put = (key, run) => env.BUCKET.store.set(`events/${day}/${key}.ndjson`, runEnd(run, 1, 3, {}, at));
	const roll = async () => (await call(env, "/rollup?day=" + day, { method: "POST", headers: auth })).json();
	const count = async () => (await (await call(env, "/summary", { headers: auth })).json()).all.days[day].dates[day].run_ends;
	put("10-00-00.000-m", "a"); put("10-00-03.500-m", "b");
	assert.equal((await roll()).files_read, 2);
	put("10-00-03.500-a", "c");      // the same millisecond as the cursor, an id that sorts before it
	put("10-00-01.200-z", "d");      // written by a machine whose clock is two seconds behind
	put("10-00-04.000-q", "e");      // and an ordinary later one
	const r = await roll(); assert.equal(r.files_read, 3); assert.equal(r.files_total, 5); assert.equal(await count(), 5, "each folded once");
	assert.equal((await roll()).files_read, 0); assert.equal(await count(), 5, "and never twice");
	// a burst bigger than a batch inside the slack still gets through, 38 at a time
	for (let i = 0; i < 60; i++) put(`10-00-04.${String(100 + i)}-b`, "burst" + i);
	const b1 = await roll(); assert.equal(b1.files_read, 38); assert.equal(b1.remaining, true);
	const b2 = await roll(); assert.equal(b2.files_read, 22); assert.equal(b2.remaining, false); assert.equal(b2.complete, true);
	assert.equal(await count(), 65); assert.equal((await roll()).files_read, 0);
});

test("progress: where runs stop without a prestige, when each level is reached, and where fights are lost", async () => {
	const env = mkEnv(), day = "2025-03-05", at = { time: day + "T12:00:00Z" }, two = { ...at, install: "i2", session: "s2" };
	const prog = (run, data, o = at) => ev("progress", { run, ...o }, { n: 1, secs: 0, levels: [], fails: {}, ...data });
	const lines = [
		// run a: begins at 1, gets to 4, loses fights there, and is never heard from again
		prog("a", { from: 0, to: 1, levels: [[1, 0]] }),
		prog("a", { from: 1, to: 4, secs: 300, levels: [[2, 60], [3, 150], [4, 290]], fails: { 3: 1 } }),
		prog("a", { from: 4, to: 4, secs: 900, fails: { 4: 5 } }),      // no new level: only the fights lost
		// run b: gets to 4 too, and prestiges there
		prog("b", { from: 0, to: 1, levels: [[1, 0]] }, two),
		prog("b", { from: 1, to: 4, secs: 400, levels: [[2, 100], [3, 250], [4, 390]], fails: { 4: 1 } }, two),
		runEnd("b", 1, 4, { secs: 600 }, two),
		// run c: a Head start, so it begins at 6 and never reached 1 to 5; it stops at 7
		prog("c", { n: 9, from: 0, to: 6, levels: [[6, 0]] }, two),
		prog("c", { n: 9, from: 6, to: 7, secs: 80, levels: [[7, 80]] }, two),
		// nonsense
		prog("d", { from: "x", to: -3, levels: [[0, 5], "no", [2.5, 1], [3, "soon"], [3, 1e12]], fails: { x: 2, 4: "many", 2: 1 } }),
		prog("e", { to: 2, levels: "all of them", fails: [1, 2] }),
	];
	env.BUCKET.store.set(`events/${day}/10-00-00.000-a.ndjson`, lines.join("\n"));
	await call(env, "/rollup?day=" + day, { method: "POST", headers: auth });
	const m = (await (await call(env, "/summary", { headers: auth })).json()).all.days[day].dates[day];
	assert.equal(m.progress, 9); assert.equal(m.runs, 5);
	assert.deepEqual(m.open_at, { 1: 0, 4: 2, 6: 0, 7: 1, 2: 1 }, "each run once, at the level it was last heard from");
	assert.deepEqual(m.ends_by_level, { 4: 1 }, "so one of the two runs at level 4 stopped there without a prestige");
	assert.deepEqual(m.reach_n, { 1: 2, 2: 2, 3: 4, 4: 2, 6: 1, 7: 1 }); assert.deepEqual(m.reach_secs, { 1: 0, 2: 160, 3: 400, 4: 680, 6: 0, 7: 80 });
	assert.deepEqual(m.fails_by_level, { 3: 1, 4: 6, 2: 1 });
});

test("players: each browser's play time, depth and runs, the same however often a day is merged", async () => {
	const env = mkEnv(), d1 = "2025-03-06", d2 = "2025-03-07";
	const at = (day, hm, o = {}) => ({ time: `${day}T${hm}:00.000Z`, ...o }), two = { install: "i2", session: "s2", os: "Mac" };
	env.BUCKET.store.set(`events/${d1}/10-00-00.000-a.ndjson`, [
		// i1: a new save, plays its first run for 9 minutes without ever reaching the tree (only progress says so)
		ev("session_start", at(d1, "10:00"), { n: 1, deepest: 1, level: 1, playtime: 0, fresh: true }),
		ev("progress", { run: "r1", ...at(d1, "10:04") }, { n: 1, from: 0, to: 2, secs: 240, levels: [], fails: {} }),
		ev("progress", { run: "r1", ...at(d1, "10:09") }, { n: 1, from: 2, to: 3, secs: 540, levels: [], fails: {} }),
		// i2: finishes run 4, begins run 5 and gets 5 minutes into it
		runEnd("q4", 4, 12, { playtime: 5000, deepest: 12 }, { ...two, ...at(d1, "11:00") }),
		runStart("q5", 5, { playtime: 5000, deepest: 12 }, { ...two, ...at(d1, "11:01") }),
		ev("progress", { run: "q5", ...two, ...at(d1, "11:06") }, { n: 5, from: 1, to: 9, secs: 300, levels: [], fails: {} }),
		ev("progress", { run: "", install: "", time: "nonsense" }, { secs: 1e12, to: "deep" }),
	].join("\n"));
	env.BUCKET.store.set(`events/${d2}/09-00-00.000-a.ndjson`, [
		ev("session_start", { ...two, ...at(d2, "09:00"), os: "Windows", version: "0.88.0" }, { n: 5, deepest: 12, level: 14, playtime: 5600 }),
		runEnd("q5", 5, 15, { playtime: 6100, deepest: 15 }, { ...two, ...at(d2, "09:10"), os: "Windows", version: "0.88.0" }),
	].join("\n"));
	const roll = (d) => call(env, "/rollup?day=" + d, { method: "POST", headers: auth });
	await roll(d1); await roll(d2); await roll(d1); await roll(d2);
	const s = await (await call(env, "/summary", { headers: auth })).json(), P = s.all.players;
	assert.deepEqual(Object.keys(P).sort(), ["i1", "i2"]);
	assert.equal(P.i1.playtime, 540, "nine minutes, though the save never said so itself"); assert.equal(P.i1.deepest, 3); assert.equal(P.i1.runs, 0); assert.equal(P.i1.run, 1);
	assert.equal(P.i1.first, d1 + "T10:00:00.000Z"); assert.equal(P.i1.last, d1 + "T10:09:00.000Z"); assert.equal(P.i1.os, "Windows");
	assert.equal(P.i2.playtime, 6100); assert.equal(P.i2.deepest, 15); assert.equal(P.i2.runs, 5); assert.equal(P.i2.first, d1 + "T11:00:00.000Z"); assert.equal(P.i2.last, d2 + "T09:10:00.000Z");
	assert.equal(P.i2.os, "Windows", "as last seen"); assert.equal(P.i2.version, "0.88.0");
	// the first day alone: five minutes past where run 5 began
	const day1 = JSON.parse(env.BUCKET.store.get(`summary/${d1}.json`)).players.i2; assert.equal(day1.playtime, 5300); assert.equal(day1.runs, 4); assert.equal(day1.deepest, 12);
	// merging again changes nothing
	const before = JSON.stringify(P); await roll(d1); await roll(d2);
	assert.equal(JSON.stringify((await (await call(env, "/summary", { headers: auth })).json()).all.players), before);
});
