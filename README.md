# smeltworks-idle-logging

Telemetry backend and dashboard for [Smeltworks Idle](https://github.com/sdwr/smeltworks-idle). Built on the same
pattern as `smeltworks-logging`, with the rollup and the dashboard rewritten for what the idle game needs to know:
how long runs are, how deep they go, which prestige nodes are bought, and what is done at the forge.

- **Worker** (`src/`): a Cloudflare Worker that accepts NDJSON play-data events from the game and stores them in R2.
  The read API is gated by a Bearer token.
- **Dashboard** (`docs/`): static HTML/JS served by GitHub Pages. It asks for the worker URL and token on load,
  fetches the rollup summary and the latest events, and draws:
  - activity over time (runs, players, errors);
  - **where runs end**: by deepest level, the runs that prestiged there and the runs that just stopped;
  - **time to reach each level** and **fights lost on it**: the pacing curve, and where the wall is;
  - **runs finished**: the share of runs begun that reached a prestige, by run number;
  - **depth, run length and tree size by run number**: a save's first run, its second, and so on;
  - **forge and weapons per run**: forged, equipped, scrapped, type and socket rerolls, upgrades;
  - **skills and crafting per run**: dropped, bought, salvaged, and each craft;
  - **nodes**: bought (and for which run on average), held as a run begins, unspecced, and never bought;
  - **players**: one row per browser with its total play time, runs finished, deepest level and when it was first and last seen, and how the players spread over play time and runs finished;
  - errors, platform and version, and a feed of recent sessions.
- **Rollups**: a Worker can only open about 50 subrequests per invocation on the free plan, so reading raw history
  is capped at about 45 files. Instead each receipt day is folded into `summary/<day>.json` (incrementally, from a
  cursor) and merged into `summary/all.json`, which the dashboard reads in one call. An hourly cron rolls up today
  and yesterday; the dashboard backfills any older day that is not complete when it loads.

## What the game sends, and when

Nothing, unless the game is running at its hosted address (`sdwr.github.io`). There it is on by default and
announced: the first box a new player sees has a ticked "Send anonymous play data" line, a player with an older
save gets a one-time notice with the same line, and Settings has the switch for good. Nothing is sent before one
of those boxes has been closed, and nothing after the line is unticked. The client is `js/telemetry.js` in the
game's repository.

The worker stores the posted body and nothing else: no IP address, no country, no request headers.

## Security model

| What | Where | Public? |
|---|---|---|
| Worker source | this repo | yes |
| Worker URL | in the game's source | yes |
| `POST /ingest` | open to the world | yes: that is how the game writes |
| `GET /events`, `GET /days`, `GET /summary`, `POST /rollup` | needs `Authorization: Bearer <DASHBOARD_TOKEN>` | no |
| `DASHBOARD_TOKEN` | Cloudflare Worker secret, and your dashboard's localStorage | no |
| R2 bucket contents | only readable through the worker | no |
| Dashboard HTML/JS | GitHub Pages | yes (no secrets in it) |

The token never lives in the repo or in the deployed Pages site: you paste it into the dashboard once per device
and it is kept in `localStorage`. Anyone opening the dashboard without it sees a page asking for credentials.

Because `/ingest` is open, anyone can post made-up events. The rollup ignores events whose `game` is not
`SMELTWORKS_IDLE`, clamps every number, drops node ids that are not short plain ids, and cuts every string short, but treat the numbers as play data, not as audited
facts.

## Setup

Needs a Cloudflare account, Node 22.18 or later, and `npm install` once.

### 1. Create the R2 bucket

```bash
npx wrangler r2 bucket create smeltworks-idle-logging
```

The binding is already in [wrangler.jsonc](wrangler.jsonc).

### 2. Set the dashboard token

Generate a long random string (for example `openssl rand -base64 32`) and store it as a worker secret:

```bash
npx wrangler secret put DASHBOARD_TOKEN
# paste the string when prompted
```

Keep the token somewhere: you paste it into the dashboard once per browser.

### 3. Deploy the worker

```bash
npx wrangler deploy
```

Wrangler prints the URL. On the `sdwr` Cloudflare account that is `https://smeltworks-idle-logging.sdwr.workers.dev`,
which is what the game posts to (`D.TELEMETRY.url` in the game's `js/data.js`). If yours differs, change
it there and in `DEFAULT_WORKER_URL` in [docs/app.js](docs/app.js).

### 4. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`.** There is no workflow and no
build. The dashboard is then at `https://sdwr.github.io/smeltworks-idle-logging/`.

### 5. Open the dashboard

Paste in the worker URL (without `/ingest`) and the `DASHBOARD_TOKEN` from step 2, and press refresh. The token
stays in that browser's localStorage until you click "forget".

## Endpoints

```
POST /ingest               body: NDJSON, one event per line. open.
GET  /events               the latest 45 files of events. auth.
GET  /events?day=YYYY-MM-DD&limit=N    auth.
GET  /days                 the days that have events. auth.
GET  /summary              { today, days, all }: all = merged per-day rollups. auth.
POST /rollup?day=YYYY-MM-DD  fold one batch (<= 38 files) of that day into
                           summary/<day>.json and summary/all.json. Returns
                           { remaining }: call again until it is false. auth.
GET  /health               status string. open.
```

Limits: 200 KB per POST, 45 files per `/events` read, 38 files per `/rollup` call.

The game posts with `Content-Type: text/plain`, which a browser sends cross-origin without a preflight request.

Raw files are keyed `events/<receipt-day>/<HH-MM-SS.mmm>-<uuid>.ndjson`, time-prefixed so rollups can resume from a
cursor. Rollup metrics are bucketed by the event's own `time` date (clamped to the receipt day), so a queue sent
days later still lands on the day it was played. Cron: `15 * * * *` in [wrangler.jsonc](wrangler.jsonc).

## Event schema

Every event is one JSON object on one line:

```json
{
  "type": "session_start" | "run_start" | "progress" | "run_end" | "error",
  "game": "SMELTWORKS_IDLE",
  "version": "0.85.0",
  "install": "<random id, kept in the browser>",
  "session": "<random id, one per page load>",
  "run": "<random id, one per run, kept in the save>",
  "time": "2026-11-23T04:01:46.000Z",
  "host": "sdwr.github.io",
  "os": "Windows" | "Mac" | "Linux" | "Android" | "iOS" | "Other",
  "data": { ... }
}
```

`data` by `type`:

- **session_start** (the page is opened): `{ n, deepest, level, secs, playtime, nodes, cores, fresh }`. `n` is the
  number of the run in progress, `level` and `secs` how deep and how long it is so far, `deepest` the save's best,
  `nodes` how many tree nodes it holds. `fresh` is true for a save with no run finished and no kill.
- **run_start** (a run begins from the prestige tree): `{ n, deepest, cores, nodes: [ids], bought: [ids],
  dropped: [ids], playtime }`. `nodes` is everything held as the run begins; `bought` and `dropped` are what that
  visit to the tree changed (a node bought and unspecced in the same visit appears in neither).
- **progress** (how far the run has got): `{ n, from, to, secs, levels: [[level, secs], ...], fails: { level: count } }`.
  Not one per level: it goes with the game's two-minute post, when the page is left, and before a `run_end`, and
  only if the run has reached a new level since the last one (or has lost fights and ten minutes have passed).
  `from` and `to` are the deepest level as last reported and now (`from` is 0 the first time, which is sent as the
  run begins); `levels` is each level reached since, with the run's game time when it was; `fails` the fights lost
  since, by the level they were lost on. A run with a Head start begins at its first level: the levels it skipped
  are never in `levels`.
- **run_end** (prestige): `{ n, level, secs, kills, fails, cores, first, weapons, ups, skills, deepest, playtime,
  counts: { ... } }`
  - `level` is the deepest level the run reached, `secs` its length in game seconds, `fails` the fights it lost,
    `cores` what it earned. `first`: it went deeper than the save ever had.
  - `weapons`, `ups` and `skills` describe the line as the run ended: weapons equipped, upgrade ranks on them,
    skills socketed in them.
  - `counts` is what was done during the run: `forged`, `equipped`, `scrapped`, `reroll_type`, `reroll_sockets`,
    `upgrade` (purchases) and `upgrade_ranks` (ranks gained), `craft_strip`, `craft_recast`, `craft_add`,
    `craft_third`, `craft_morph`, `market` (skills bought), `salvage`, `drops`. A key the worker has not seen
    before is summed like the rest and shown on the dashboard under its own name.
- **error**: `{ message, stack }`, at most five per page load, with addresses cut down to file names.

A run that is never ended (the player stops coming back) has a `run_start` and `progress` events and no
`run_end`. The rollup counts every run once at the level it last reported (`open_at`: each `progress` adds one at
`to` and takes one away at `from`); less the runs that prestiged at that level, that is the runs that stopped
there. A run still being played looks the same as one that was abandoned until it ends, so the newest day or two
of any range overstate the stops; and over a short range a level can come out negative (the run was there before
the range began), which the dashboard shows as none.

### What the rollup keeps

Per date, counts and sums only (never an average), so days add together: see `DateMetrics` in
[src/index.ts](src/index.ts). Runs are numbered from 1 on each save and everything from the 60th on shares one
bucket; levels past 500 share one. If `DateMetrics` changes shape, bump `SUMMARY_VERSION`: every day is then
rebuilt from the raw files the next time the dashboard loads.

### Players

`summary/all.json` also holds `players`: one record per install id (a random id per browser), with the highest
play time, deepest level and runs finished it has reported, the run it was last seen in, and its first and last
event times. Nothing new is asked of the game: it comes from what every event already carries. Play time is the
save's game time; for a run in progress it is taken from the `progress` events, so it is at most a couple of
minutes behind. At most 5,000 players are kept.

### Node names

The dashboard labels nodes from [docs/nodes.js](docs/nodes.js), which is generated from the game. After the tree
changes:

```bash
node tools/nodes.cjs ../smeltworks-idle
```

A node the file does not know is shown by its id.

## Tests

```bash
npm test
```

runs the worker against an in-memory stand-in for the bucket (`test/worker.test.mjs`). It needs no install: Node
runs the TypeScript source directly.

## Local development

```bash
npx wrangler types   # once, and after changing bindings: writes worker-configuration.d.ts
npx wrangler dev     # worker on http://localhost:8787
```

For the dashboard, open `docs/index.html` in a browser, or serve it:

```bash
cd docs && python -m http.server 8000
```

When testing locally, put `DASHBOARD_TOKEN=whatever` in `.dev.vars` (gitignored), point the dashboard at
`http://localhost:8787` through the settings gear, and paste the same token.

## Reading from R2 directly

If the worker breaks, the files are still there:

```bash
npx wrangler r2 object list smeltworks-idle-logging --prefix events/2026-11-23/
npx wrangler r2 object get smeltworks-idle-logging/events/2026-11-23/<key>.ndjson
```

## A window on the timeline, and marks

The range buttons at the top (7d, 30d, 90d, all) set how much of the timeline the Activity chart shows. Under them is
the **window**: drag across the chart, or pick two dates, and every number on the page (the tiles, the bar charts, the
player list) is for those days only, with the window shaded on the chart. The tiles then compare it with the same number
of days just before. Clear puts it back.

**Marks** are dates worth remembering, a launch post say. Add one with its date and a name and it is drawn on the chart
as a dashed line. Click a mark and the window becomes the days from that mark to the day before the next one (or to
today), compared with the same number of days after the mark before it: the first days after one post against the
first days after the last. The Players heading says how many players were first seen in the window and how many of
those were seen again on a later day, and the same for the days it is compared with.

The window and the marks are kept in this browser only. Days are UTC days, as the worker keeps them, so a post made in
the evening in North America lands on the next day's column.
