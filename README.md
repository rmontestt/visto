# Visto

**Your YouTube watch history as a dashboard.** What you watched each day (as far back as
YouTube keeps it), estimated and measured watch time, likes, dislikes, favorites, topics,
top channels with their avatars, subscriptions, when you watch and what you rewatch.

A browser extension reads your history from youtube.com. Google Takeout fills in exact
times and older data. The dashboard runs **on your own computer** (`npm start`), or on your
own free Cloudflare account if you want it live everywhere (`npm run cloud`). Your data
never goes to anyone else's server.

- **Local by default.** A small server on `localhost` stores everything in a SQLite file in
  this folder. You don't need an account.
- **Cloud if you want it.** The same code runs on Cloudflare Workers + D1, on the free
  plan.
- **Private by design.** Comments and searches are never collected, and only your
  Favorites playlist is shown (see [Privacy](#privacy)).

## Quick start (local)

You need [Node.js](https://nodejs.org) 20+ and a Chromium browser (Chrome, Brave, Edge…).

1. **Get the code and start the dashboard**
   ```bash
   git clone https://github.com/rmontestt/visto.git
   cd visto
   npm install
   npm start
   ```
   `npm start` creates the local database, prints a **connection code** and serves the
   dashboard at http://localhost:8787. Keep it running while you use it. `npm run connect`
   prints the code again.
2. **Install the extension**: open `chrome://extensions` (or `brave://extensions`), turn
   on **Developer mode**, click **Load unpacked** and pick the `extension/` folder.
3. **Connect it**: click the Visto icon, paste the connection code, click **Connect** and
   allow access to `localhost`.
4. **Choose what to collect**: the popup's switches are **Watch history** (every video you
   watch, plus watch time in that browser), **Likes** and **Favorites** (your playlist
   called Favorites). All are on by default.
5. **Import**: open youtube.com signed in to your account, then click **Full import** in the
   popup. A YouTube tab opens and goes through what you chose, in order: your whole
   history, then your liked videos, then your Favorites. Keep it visible; it closes when
   it's done.
   - The history takes a few minutes, even for tens of thousands of videos.
   - If a step stops, click the button again: it resumes at that step.
6. **Open the dashboard**: the red **Open dashboard** button at the top of the popup, or
   http://localhost:8787.

From then on the extension syncs the first page of each list you chose every hour, while
your browser is open. If the local dashboard isn't running, it keeps everything queued and
sends it later. Turning a switch off stops collecting that kind of data; what was already
imported stays.

**Coming back after a while?** Click **Update (only what's new)**. It reads the history
back to the day your last import already covered (with a two-day overlap), and the liked
videos and Favorites down to the first videos it had already sent. It takes seconds
instead of minutes. **Full import** is still there to re-read everything; nothing is ever
duplicated.

The dashboard shows only what you collect. Someone who imports only likes, or history and
Favorites, sees a dashboard made of exactly that.

### Optional: durations, topics and channel avatars

Add a free [YouTube Data API](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
key:
1. Create a project and enable *YouTube Data API v3*.
2. Under *Credentials*, create an *API key* and restrict it to that API.
3. Add a line `YOUTUBE_API_KEY=...` to `worker/.dev.vars`.
4. Restart `npm start`. It enriches ~2,000 videos every 5 minutes while it runs.

To do it all in one go, run `python ingest/classify_local.py`. It costs 1 quota unit per 50
videos, against a free quota of 10,000 units a day.

### Optional: Google Takeout (exact times and older data)

The history page only gives the **day** of each view. Takeout adds the **exact time**,
which powers the watch-time estimate and "When you watch". It also adds dated likes back to
the start of your account, dislikes and subscriptions.

1. Go to https://takeout.google.com while signed in to **the same account** as in your
   browser.
2. Deselect everything, then select:
   - **My Activity**: under *Multiple formats*, set *Activity records* to **JSON**; under
     *All activity data included*, keep only **YouTube**.
   - **YouTube and YouTube Music**: set the history format to **JSON** and untick
     **videos** (your uploads can take gigabytes).
3. Export once (or every 2 months), and download the `.zip` files.
4. Import them. You need [Python](https://www.python.org) 3.10+; on Windows run
   `python -m pip install -r requirements.txt` once for the time-zone database. Then:
   ```bash
   python ingest/takeout_import.py path/to/takeout-*.zip --apply-local
   ```

The importer reads the zips directly, in English or Spanish exports, and is idempotent:
importing a newer Takeout never duplicates anything. `ingest/takeout_watch.py --local`
imports each new export found in a folder (`--folder` or `TAKEOUT_DIR` in `.env`) exactly
once, which is handy with Google Drive for desktop and a scheduled task.

## Cloud mode (optional)

Run the same dashboard on your own Cloudflare account, so it's live from anywhere and your
phone can see it:

```bash
npm run cloud
```

The first run:
1. logs you in to Cloudflare (a browser window opens);
2. asks for a Worker name, your time zone and whether the dashboard should be public
   (read-only, no password) or behind a password;
3. creates the D1 database, deploys the Worker and sets its secrets;
4. prints the URL, the password and a new connection code.

Paste that code in the extension ("Change connection"). Running `npm run cloud` again later
redeploys and keeps your settings. Settings live in the git-ignored
`worker/wrangler.local.jsonc` and `.env`.

**Mind the free D1 quota: 100k rows written and 5M rows read per day, for the whole
Cloudflare account.** A full import of a long history writes ~4 rows per view, so 50k views
is ~200k writes, about two or three days' worth. Two ways to handle that:
- Let the extension send it straight to the cloud. It retries on its own each day until
  everything is in.
- Or import locally first, then ship it within each day's budget:
  ```bash
  python ingest/push_prod.py            # plan: what is missing, and what it costs
  python ingest/push_prod.py --apply    # write up to today's budget; run again the next day
  ```

  `push_prod.py` reads your account's usage for the day, writes only the difference, never
  deletes views that only the cloud has, and can finish the setup:
  - `--deploy` publishes the Worker;
  - `--set-api-key` stores `YOUTUBE_API_KEY` as a secret once the video metadata is in, so
    the cron doesn't fetch it twice.

The Worker's hourly cron enriches ~400 new videos an hour in the cloud (`ENRICH_API_CALLS`).
Once the dashboard is public, its API answers are cached for 10 minutes to save reads.

## Where every number comes from

| Source | What it gives | Limits |
|---|---|---|
| **Extension · Full import** | Your whole youtube.com/feed/history, from all your devices: one row per (video, day) | Day only, no time. The history page dates views in UTC and ends where YouTube stops keeping it (for long-time users, around late 2016) |
| **Extension · hourly sync** | The first page of your history, liked videos and Favorites | If the browser stays closed for many days, a gap can appear; **Update** fills it |
| **Extension · live** | Seconds you actually played, and like/unlike clicks, with exact times | Only what you watch in that browser |
| **Extension · liked videos** | Every like, read by scrolling the real "Liked videos" page | Unavailable videos are hidden by YouTube. The page doesn't say when you liked each one, so likes from the first import have no date |
| **Extension · Favorites** | Your playlist called Favorites (or Favoritos, Favoris…), found on your playlists page and scrolled the same way | No date added (Takeout has it) |
| **Takeout · My Activity (JSON)** | The complete, timed source: every view with its time, dated likes, dislikes, subscriptions | You request it by hand (or every 2 months) |
| **Takeout · YouTube and YouTube Music** | Favorites playlist, current subscriptions | Its own watch history is capped at ~2 years: use My Activity for that |
| **YouTube Data API** | Duration, category, publish date, topics → theme; channel avatars and handles | Optional free key |

**Counting.** Visto counts **distinct (video, day) pairs**. The sources overlap on purpose,
and a video seen by several of them on the same day counts once.

**Watch time is an estimate.** For each (video, day), Visto uses the first of these that
exists:
1. the seconds measured in your browser;
2. the time until your next timed view, capped by the video's length and by 3 h;
3. the video's length.

It's good for comparing months and years, not exact hours. It tends to run high, because the
last video of each session counts in full (there's no next view to measure against). No
official source gives a viewer's real watch time: the YouTube Analytics API is only for
channel owners, and Takeout doesn't include it.

**Shorts.** A view counts as a Short if it was watched after Shorts launched (2020-09-14)
and either YouTube marks the video as one, or it's 60 s or shorter and was uploaded after
that date.

**Deleted or private videos** disappear from every panel once the API stops returning
them. They're kept as a tombstone so no import brings them back.

## Privacy

- **Comments** are never captured, imported, stored or shown.
- **Searches** (and visits and shares from My Activity) are never imported.
- **Playlists**: only **Favorites** is shown.
- Local mode keeps everything on your computer. Cloud mode keeps it in *your* Cloudflare
  account. The extension only talks to youtube.com and to the dashboard you connected.
- Dashboard pages are marked `noindex`. A cloud dashboard is private (password) unless you
  choose public when you set it up.

## Using the dashboard

Filters:
- **Period**: one filter at the top, **All time** or a **year**. Every panel follows it.
- **Topic**: click a topic to filter every panel by it.
- **Selection**: a bar in "Your activity", a slot in "When you watch", or a channel. It
  lists its videos below.

Clicking the same thing again clears it, and every active filter is shown with a ✕.

Sections:
- **Headline figures**: a year compares with the same dates of the year before. Streaks are
  counted inside the period.
- **Your activity**: bars per month (all time) or per week (a year), switchable between
  **Videos** and **Time**, with a data table.
- **Topics**: the ones with at least 5 %, plus "See all". A stacked chart shows how they
  changed by year.
- **Main list**:
  - it shows the latest 5 videos of the period or selection, paged, with a separator per
    day;
  - clicking a day shows the whole day, with arrows to the previous and next day;
  - search (`/`) finds anything in your history.
- **Side panels**:
  - top channels, Favorites, Liked videos and Subscriptions, 5 per page (Favorites and
    Subscriptions are sortable);
  - "When you watch" (weekday × hour) and the format split.
- **Only what you collect**: each panel appears only if its data exists. For example,
  "When you watch" needs timed views, from Takeout or the browser, and Topics needs a
  YouTube API key.

## How it works

```text
Browser extension ──POST /api/ingest──► Worker ──► D1 / local SQLite
  · hourly: first page of history + liked     ▲   cron / `npm start`: metadata,
  · live: seconds played, like clicks         │   topics, avatars, purge of
  · Full import on demand                     │   deleted videos (YouTube API)
                                              ▼
                              Dashboard (static SPA in worker/public)
Google Takeout zips ── ingest/takeout_import.py ──► local (or cloud) database
Local database ── ingest/push_prod.py ──► cloud D1, within the daily quota
```

| Path | What |
|---|---|
| `worker/src/index.js` | Routing, auth: ingest bearer token, dashboard password/session, `PUBLIC_DASHBOARD`; API cache |
| `worker/src/stats.js` | Every dashboard query |
| `worker/src/ingest.js` | What the extension sends; every write is idempotent |
| `worker/src/enrich.js` | Metadata, topics, channel avatars, purge of deleted videos |
| `worker/src/themes.json` | The topic taxonomy (YouTube topic slugs first, category as a fallback) |
| `worker/public/` | The dashboard: `index.html`, `app.js` (hand-drawn SVG charts), `styles.css` |
| `worker/schema.sql`, `worker/migrations/` | Database schema, and upgrades for existing databases |
| `extension/` | Manifest V3 extension: `parser.js` (shared), `background.js`, `content.js`, `popup.*` |
| `ingest/` | Python: Takeout import, local enrichment, local → cloud sync, shared config |
| `scripts/visto.mjs` | `npm start`, `npm run connect`, `npm run cloud`, `npm run wrangler -- …` |

Local files, all git-ignored:
- `worker/.dev.vars`: local settings, written by `npm start`: time zone, ingest token,
  optional `YOUTUBE_API_KEY`.
- `worker/wrangler.local.jsonc` and `.env`: the cloud deployment and its secrets.
- `.wrangler/state/`: the local database.
- `data/`: generated SQL and the Takeout watcher's state.

### Data model

- `watches`: one row per report of a view. `dedup_key` makes re-sends harmless:
  - `t|video|ts` for Takeout;
  - `h|video|day` for the history page;
  - `l|video|startedAt` for live sessions, which keep the largest seconds seen.

  `day`, `hour` and `dow` are local time, computed when the row is written.
- **Takeout merge.** A Takeout view lends its time to the existing history row for that
  (video, day). It moves the row if the UTC day and your local day differ. It only creates
  a row when no source had seen that pair.
- **Other tables:**
  - `videos`: metadata, topics, theme; `meta_source = 'gone'` marks a tombstone;
  - `likes`: `liked_at` is null when the like predates tracking;
  - `dislikes`;
  - `saves`: playlists; only Favorites is shown;
  - `channels`: avatar, subscription date, current subscription;
  - `sync_log`.

## Development

- `npm start` runs `wrangler dev` with hot reload of `worker/`, and you can open
  http://localhost:8787 directly. Locally, `DEV_NO_AUTH=1` skips the password.
- After changing the extension, click reload in `chrome://extensions` and reload any open
  YouTube tabs.
- The extension icons in `extension/icons/` are drawn from the logo geometry
  (`worker/public/favicon.svg`) by `python scripts/make_icons.py`.
- For quick queries, open the local database with any SQLite tool while the server is
  stopped: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`.
- Cloud:
  - `npm run deploy` publishes;
  - `npm run tail` shows live logs;
  - `npm run wrangler -- d1 execute <db> --remote --file worker/migrations/00N_*.sql`
    applies a migration.
- History parsing understands YouTube in English and Spanish. For another UI language,
  extend `MONTHS`/`WEEKDAYS` in `extension/parser.js`, and the verb prefixes in
  `ingest/takeout_import.py` for Takeout.

**Troubleshooting**
- *The popup says "dashboard unreachable"*: `npm start` isn't running. Nothing is lost:
  it's queued.
- *"the dashboard rejected the token"*: paste a fresh code from `npm run connect` (or
  `npm run connect -- cloud`).
- *The full import stopped*: click it again; it resumes. Keep its tab visible, because
  browsers slow down hidden tabs.
- *`npm`/`npx` can't find `node` in some Windows shells* (`"node" is not recognized…`): run
  `node scripts/visto.mjs start` directly. If `npm install` fails the same way while
  installing esbuild or workerd, install without scripts and run their two installers with
  node:
  ```bash
  npm install --ignore-scripts
  node node_modules/esbuild/install.js
  node node_modules/workerd/install.js
  ```

## Roadmap

- Importing Takeout from the dashboard itself, with no Python.

## License

[MIT](LICENSE)
