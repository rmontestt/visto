# CLAUDE.md

**Visto**: a self-hosted YouTube watch-history dashboard. A Manifest V3 browser extension
plus a Cloudflare Worker (plain ESM, no build) that runs locally (`npm start`,
wrangler dev + local SQLite) or on the user's own Cloudflare account (`npm run cloud`,
Workers + D1). All UI and docs are in English. **README.md** has the full picture: every
data source and its limits, the data model, both modes and the extension. Read it first;
this file holds the rules and the traps.

## Layout

- `worker/src/index.js`: routing, auth and the API cache.
  - Auth: bearer `INGEST_TOKEN` for `/api/ingest`; password + HMAC session cookie
    otherwise; `PUBLIC_DASHBOARD=1` opens the read-only dashboard; `DEV_NO_AUTH=1` skips
    login on localhost only.
  - The API cache (10 min) applies only when public and not localhost.
- `worker/src/stats.js`: every dashboard query.
  - SQL builders: `WD` (the (video, day) unit), `GAP_EST` (watch-time estimate), `FORMAT`
    (Shorts rule), `ROW` (per-video flags).
  - Filters: `themeFilter`, `optionalRange`, `selectionFilters`.
- `worker/src/ingest.js` handles extension payloads; comment events are dropped.
- `worker/src/enrich.js` is the cron. It uses videos.list (topics → theme) and
  channels.list (avatars), or oEmbed without a key, and purges gone videos. Locally,
  `scripts/visto.mjs` triggers it every 5 min through `/cdn-cgi/local/scheduled`.
- `worker/src/themes.json` is the single topic taxonomy. It is applied by `themes.js` and
  `ingest/classify_local.py`. Ids are English and stored in `videos.theme`; renaming one
  means updating stored rows.
- `worker/public/`: the SPA.
  - `app.js` state is `{range: 'all'|'YYYY', theme, sel, day, dayPinned, metric}`; the
    hash is `#r=&t=&d=&m=`.
  - Locale is `en-US` (`LOCALE`, `fmtDate`, `plural`).
- `worker/wrangler.jsonc` is a **template** (placeholder D1 id, `TZ=UTC`, private) and is
  what local dev uses. `npm run cloud` writes the git-ignored `worker/wrangler.local.jsonc`
  with the real Worker name, D1 id, TZ and visibility.
- `worker/schema.sql` is the canonical schema for fresh databases. `worker/migrations/`
  upgrades older ones: 002 topics/channels/dislikes, 003 drop comments, 004 partial
  pending indexes.
- `extension/`:
  - `parser.js` is a classic script shared by the service worker (`importScripts`) and the
    content script. Keep it classic, no modules.
  - The endpoint and token come from a connection code (`visto:` + base64url
    `{u, t}`), pasted in the popup and stored in `chrome.storage.local.settings`.
  - Host access to the dashboard is an optional permission, requested on connect.
  - The popup switches (`chrome.storage.local.options`, defaults in
    `P.DEFAULT_OPTIONS`) decide what is collected: `history` (plus live watch time),
    `likes` (plus like clicks) and `favorites`.
    - Both the hourly sync and the Full import follow them.
    - The Full import runs the enabled phases in order: history → likes → favorites.
    - Each phase ends with a `phaseDone` progress message, and `afterPhase` starts the
      next one.
    - A phase cut short stays `deep.phase`, and the next Full import resumes there.
    - **Update** (`deep.mode = 'update'`) runs the same phases but stops early:
      - the history walk stops at `stopDay`, which is `status.historyCompleteUntil`
        minus 2 days. That day is set when a history phase finishes, and extended to
        today by syncs whose first page reaches it (`extendCoverage`);
      - the lists stop at the first batch of ids already sent (`status`-independent
        `known.likes` / `known.favorites`, kept by `remember` in `enqueue`);
      - with no memory yet, it reads everything, like a Full import.
    - Favorites are found by name (`P.FAVORITES`) on /feed/playlists. The playlist URL
      is kept in `status.favorites`.
- `ingest/` (Python 3.10+; stdlib plus `tzdata` on Windows):
  - `visto_config.py` finds settings, the local DB, the TZ, the wrangler config and the
    Cloudflare account;
  - `takeout_import.py`: `--apply-local` writes SQLite directly, `--apply` goes to the
    cloud;
  - `takeout_watch.py`;
  - `classify_local.py`;
  - `push_prod.py`: local → cloud diff within the day's quota.
- `scripts/visto.mjs` backs `npm start`, `connect`, `cloud` and `wrangler`.

## Invariants

- The counting unit is DISTINCT `(video_id, day)` (`WD`). Sources overlap by design;
  never sum rows across sources.
- `watches.dedup_key` formats are load-bearing:
  - `t|vid|ts` (Takeout);
  - `h|vid|day` (history page; the key keeps the original day even after a Takeout merge
    moved the row);
  - `l|vid|startedAt` (live, upserted with MAX(seconds)).
- `day`, `hour` and `dow` are local (the `TZ` var) and computed at insert time. SQLite
  never converts time zones.
- History rows carry the page's UTC date. The Takeout merge moves a row when its local day
  differs from its UTC day.
- `likes.liked_at IS NULL` means the like predates tracking. It does not mean "liked
  today".
- Shorts: watched on or after 2020-09-14 and (`is_short = 1`, or ≤60 s and uploaded on or
  after that date).
- Gone videos are deleted from watches, likes, dislikes and saves. The `videos` row stays
  with `meta_source = 'gone'` so imports never bring them back.
- Every panel follows the one global period (All time or a year) and the topic. Clicking
  what set a filter clears it. Lists page 5 at a time.
- Panels appear only when their data exists (`showPanels`, from the summary's
  `meta.n_likes / n_favorites / n_subs / has_timed / has_themes`).
- Favorites may come from Takeout (dated) and the extension (undated, maybe another
  language's name). Queries merge them per video (`fav` CTE in `saves`); never count
  `saves` rows directly.

## Privacy (a product rule)

- Comments and searches are never captured, imported, stored or served.
- Only the Favorites playlist is exposed.
- Check any new data source for these before importing it.
- Never commit personal data or settings: `.env`, `worker/.dev.vars`,
  `worker/wrangler.local.jsonc`, `data/`, `.wrangler/`, Takeout files, generated SQL.
- The repo must stay free of any user's names, emails, account ids, URLs or local paths.

## Cloudflare D1 free quota (cloud mode)

- Limits: **100k rows written and 5M rows read per UTC day, account-wide**. Hitting either
  blocks every D1 database on the account until 00:00 UTC.
- Index entries count as writes: ~4 per new `watches` row.
- A no-op upsert counts unless its `DO UPDATE` has a `WHERE`.
- Pending indexes are partial on purpose (migration 004).
- An "All time" summary reads ~1M rows, which is why public answers are cached.
- `push_prod.py` reads whole tables (~150k rows) per run: plan with it, don't loop it.
- Cloudflare's usage figures lag behind real writes by a while. `push_prod.py` also counts
  what it wrote itself on the current UTC day (`data/push_ledger.json`), so a second run
  the same day doesn't overshoot.
- Estimate before any bulk write. `push_prod.py` checks the day's usage (GraphQL
  `d1AnalyticsAdaptiveGroups`, wrangler's OAuth token) and stays inside it.
- Set `YOUTUBE_API_KEY` on a cloud Worker only after a bulk video sync is done, or the cron
  re-enriches the same videos.

## Traps

- Some Windows shells can't resolve `node` through `npm`/`npx` shims
  (for example `"node" is not recognized as a command`). Run `node scripts/visto.mjs start` or
  `node node_modules/wrangler/bin/wrangler.js … --config …` directly.
- Remote wrangler calls sometimes fail once with code 7403 ("account not valid"). Retry;
  `visto_config.wrangler` does.
- `wrangler d1 execute --local --file` hangs on big files. Write the local SQLite with
  Python `sqlite3` (`visto_config.local_db()`).
- The local SQLite file name is derived from the config's `database_id`. Local dev always
  uses the template (placeholder id), so the local data stays in one file whatever the
  cloud config says.
- `wrangler dev` does not run crons. The local trigger is `/cdn-cgi/local/scheduled`
  (older wranglers used `/__scheduled` with `--test-scheduled`).
- Heredocs with nested quotes break in some agent shells: write patch scripts to files.
- SQL: in `HAVING`, spell out aggregates (`SUM(pv.views) > 1`), because an alias resolves
  to one row's column. Join instead of `MAX(col)` inside correlated subqueries.
- In `/api/videos`, pick the page before decorating rows. `ROW`'s per-row subqueries over
  a whole period take seconds.
- Chart marks drawn over their hit areas need `pointer-events: none`, or clicks on the bar
  itself do nothing.
- `api()` in `app.js` fetches with `cache: 'no-cache'`, so a browser-cached answer can't
  hide new data.

## Frontend style

- YouTube-themed on purpose: top bar with pill search, chips, 16:9 thumbnails with the red
  resume bar, Roboto, dark by default.
- Charts are hand-written SVG.
- The categorical palette `--s1..--s8` was validated for colour-vision deficiency. Colour
  follows the entity (all-time topic order), never its rank.
- Check changes in a browser at desktop and phone widths, with no horizontal page scroll.
