"""Import Google Takeout exports (YouTube) into Visto's D1.

    python ingest/takeout_import.py <takeout folder or .zip files...> [--apply-local | --apply]

Reads the zips directly (no unzipping), in Spanish or English exports:
  * Mi actividad > YouTube (MiActividad.json)  -> the complete, timed source:
      "Has visto"            -> watches (merged into existing (video, day) rows, see merge_watches)
      "Te ha gustado"        -> likes (dated, back to 2011)
      "No te ha gustado"     -> dislikes
      "Te has suscrito a"    -> channels.subscribed_at / subscribed_day
      searches, visits, shares... are skipped on purpose (privacy, see README)
  * YouTube y YouTube Music:
      historial/historial de reproducciones.json -> watches (capped by Google to ~2 years)
      listas de reproduccion/*.csv                -> saves (only Favorites is shown) and likes
      suscripciones/suscripciones.csv             -> channels.subscribed = 1
      comentarios/*                               -> skipped on purpose (never imported)
Writes an idempotent SQL file (every row has a stable key, re-imports never duplicate)
and ends by purging videos tombstoned as 'gone'. --apply-local loads it into the local
dashboard (`npm start`); --apply into your Cloudflare D1 (`npm run cloud`), which is fine
for a new Takeout but not for a first import of years of history: D1's free plan allows
100k rows written per day, so import locally and ship it with ingest/push_prod.py.
Days and hours use your time zone (worker/.dev.vars or the cloud config, see visto_config).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from visto_config import ROOT, local_db, tz_name, wrangler, d1_name

TZ = ZoneInfo(tz_name())
VIDEO_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})")
CHANNEL_RE = re.compile(r"/channel/(UC[\w-]{22})")
TITLE_PREFIXES = ("Has visto ", "Viste ", "Watched ", "Has escuchado ", "Escuchaste ")
AD_MARKERS = ("google ads", "anuncios de google")
LIKED_PLAYLISTS = {"videos que me gustan", "liked videos", "me gusta"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- input files ----

@dataclass
class Source:
    name: str  # path inside the export, forward slashes
    read: callable


def iter_sources(paths: list[Path]):
    for p in paths:
        if p.is_dir():
            for f in p.rglob("*"):
                if f.is_file() and f.suffix.lower() in (".json", ".csv"):
                    yield Source(f.relative_to(p).as_posix(), f.read_bytes)
                elif f.is_file() and f.suffix.lower() == ".zip":
                    yield from iter_zip(f)
        elif p.suffix.lower() == ".zip":
            yield from iter_zip(p)
        else:
            yield Source(p.name, p.read_bytes)


def iter_zip(path: Path):
    z = zipfile.ZipFile(path)
    for info in z.infolist():
        if info.filename.lower().endswith((".json", ".csv")):
            yield Source(info.filename, lambda i=info: z.read(i))


def decode(b: bytes) -> str:
    return b.decode("utf-8-sig")


# ---------------------------------------------------------------- parsing ----

@dataclass
class Data:
    videos: dict = field(default_factory=dict)      # id -> (title, channel_id, channel_title, ts)
    watches: list = field(default_factory=list)     # (id, day, ts, hour, dow, product)
    likes: list = field(default_factory=list)       # (video_id, ts, day)
    dislikes: list = field(default_factory=list)    # (video_id, ts, day)
    saves: list = field(default_factory=list)       # (playlist, video_id, ts, day)
    subs: dict = field(default_factory=dict)        # channel_id -> [title, first_ts, subscribed_now]
    skipped: dict = field(default_factory=lambda: {"ads": 0, "removed": 0, "no_video": 0})
    unknown_verbs: dict = field(default_factory=dict)

    def video(self, vid, title=None, channel_id=None, channel=None, ts=0):
        prev = self.videos.get(vid)
        # Keep the most recent non-empty title: channels rename videos.
        if not prev or (ts or 0) >= (prev[3] or 0):
            self.videos[vid] = (title or (prev and prev[0]), channel_id or (prev and prev[1]),
                                channel or (prev and prev[2]), ts)


def local(ts_ms: int):
    d = datetime.fromtimestamp(ts_ms / 1000, TZ)
    return d.strftime("%Y-%m-%d"), d.hour, d.weekday()


def parse_time(s: str) -> int | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00").replace(" UTC", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def is_watch_history(entries) -> bool:
    return isinstance(entries, list) and any(
        isinstance(e, dict) and "time" in e and str(e.get("header", "")).startswith("YouTube") for e in entries[:50])


# "Mi actividad" exports mix every kind of YouTube activity in one file; the verb that
# opens the title says which one it is. Watch verbs are TITLE_PREFIXES.
LIKE_PREFIXES = ("Te ha gustado ", "Has indicado que te gusta ", "Has dado «Me gusta» a ", "Has dado Me gusta a ", "Liked ")
DISLIKE_PREFIXES = ("No te ha gustado ", "Disliked ")
SUB_PREFIXES = ("Te has suscrito a ", "Has suscrito a ", "Subscribed to ")
# Searches are deliberately never imported: the user considers them too private.
SKIP_PREFIXES = ("Has buscado ", "Buscaste ", "Searched for ", "Has visitado ", "Visited ", "Has compartido ",
                 "Has guardado ", "Has comentado ", "Has respondido ", "Has votado ",
                 "Subscribed to ", "Has visto una historia ", "Has respondido a ", "Has publicado ")


def strip_prefix(title: str, prefixes) -> str | None:
    for p in prefixes:
        if title.startswith(p):
            return title[len(p):]
    return None


def parse_watch_history(entries, data: Data):
    """Watch history (YouTube y YouTube Music) and Mi actividad > YouTube (JSON)."""
    for e in entries:
        if any(norm(d.get("name", "")).find(m) >= 0 for d in e.get("details", []) for m in AD_MARKERS):
            data.skipped["ads"] += 1
            continue
        raw_title = e.get("title", "")
        sub_title = strip_prefix(raw_title, SUB_PREFIXES)
        if sub_title is not None:
            cm = CHANNEL_RE.search(e.get("titleUrl", ""))
            ts = parse_time(e.get("time"))
            if cm and ts:
                cur = data.subs.setdefault(cm.group(1), [sub_title, ts, None])
                cur[1] = min(cur[1] or ts, ts)  # first time you subscribed
            continue
        if strip_prefix(raw_title, SKIP_PREFIXES) is not None:
            data.skipped["searches_etc"] = data.skipped.get("searches_etc", 0) + 1
            continue
        m = VIDEO_RE.search(e.get("titleUrl", ""))
        if not m:
            data.skipped["removed"] += 1
            continue
        ts = parse_time(e.get("time"))
        if ts is None:
            continue
        vid = m.group(1)
        liked = strip_prefix(raw_title, LIKE_PREFIXES)
        disliked = strip_prefix(raw_title, DISLIKE_PREFIXES)
        title = next((t for t in (liked, disliked) if t is not None), None)
        if title is None:
            title = strip_prefix(raw_title, TITLE_PREFIXES)
        if title is None:
            # Unknown verb: keep a sample so the next run can learn it.
            verb = " ".join(raw_title.split(" ")[:2])
            data.unknown_verbs[verb] = data.unknown_verbs.get(verb, 0) + 1
            continue
        if title.startswith("https://"):
            title = None  # removed/private: Takeout only knows the URL
        sub = (e.get("subtitles") or [{}])[0]
        cm = CHANNEL_RE.search(sub.get("url", ""))
        data.video(vid, title, cm.group(1) if cm else None, sub.get("name"), ts)
        day, hour, dow = local(ts)
        if liked is not None:
            data.likes.append((vid, ts, day))
            continue
        if disliked is not None:
            data.dislikes.append((vid, ts, day))
            continue
        product = "music" if e.get("header") == "YouTube Music" else "youtube"
        data.watches.append((vid, day, ts, hour, dow, product))


def csv_rows(text: str):
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return [], []
    return [norm(h) for h in rows[0]], rows[1:]


def col(headers, *needles, avoid=()):
    for i, h in enumerate(headers):
        if all(n in h for n in needles) and not any(a in h for a in avoid):
            return i
    return None


def first(*indexes):
    """First column index that was found (0 is a valid index, so no `or`)."""
    return next((i for i in indexes if i is not None), None)


def parse_subscriptions(text: str, data: Data):
    """suscripciones.csv: the channels you are subscribed to right now (no dates)."""
    h, rows = csv_rows(text)
    c_id = first(col(h, "id", "canal"), col(h, "channel id"))
    c_title = first(col(h, "titulo"), col(h, "title"))
    if c_id is None:
        return
    for r in rows:
        cid = r[c_id].strip() if c_id < len(r) else ""
        if not re.fullmatch(r"UC[\w-]{22}", cid):
            continue
        cur = data.subs.setdefault(cid, [None, None, None])
        cur[0] = cur[0] or (r[c_title].strip() if c_title is not None and c_title < len(r) else None)
        cur[2] = 1


def parse_playlist(name: str, text: str, data: Data):
    h, rows = csv_rows(text)
    c_vid = col(h, "id", "video")
    c_ts = first(col(h, "marca de tiempo"), col(h, "timestamp"))
    if c_vid is None:
        return
    title = re.sub(r"[-_ ]*(videos|v.deos)$", "", Path(name).stem, flags=re.I).strip()
    liked = norm(title) in LIKED_PLAYLISTS
    for r in rows:
        if c_vid >= len(r):
            continue
        vid = r[c_vid].strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
            continue
        ts = parse_time(r[c_ts]) if c_ts is not None and c_ts < len(r) else None
        day = local(ts)[0] if ts else None
        data.video(vid)
        if liked:
            data.likes.append((vid, ts, day))
        else:
            data.saves.append((title, vid, ts, day))


def collect(paths: list[Path]) -> Data:
    data = Data()
    for src in iter_sources(paths):
        low = norm(src.name)
        if "youtube" not in low and "takeout" in low:
            continue  # other Google products in a combined export
        if src.name.lower().endswith(".json"):
            try:
                entries = json.loads(decode(src.read()))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if is_watch_history(entries) and "search" not in low and "busqueda" not in low:
                n = len(data.watches)
                parse_watch_history(entries, data)
                print(f"  watch history  {src.name}: {len(data.watches) - n} views")
        elif src.name.lower().endswith(".csv"):
            parts = low.split("/")
            if any(p in ("comentarios", "comments") for p in parts):
                continue  # comments are private by the user's choice: never imported
            elif any(p in ("suscripciones", "subscriptions") for p in parts):
                parse_subscriptions(decode(src.read()), data)
                print(f"  subscriptions  {src.name}: {sum(1 for s in data.subs.values() if s[2])}")
            elif any(p in ("listas de reproduccion", "playlists") for p in parts) and not low.endswith(("/playlists.csv", "/listas de reproduccion.csv")):
                parse_playlist(src.name, decode(src.read()), data)
    return data


# ---------------------------------------------------------------- SQL ----

def q(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(int(v))
    return "'" + str(v).replace("'", "''") + "'"


def inserts(head: str, rows, tail: str = "", chunk: int = 200):
    for i in range(0, len(rows), chunk):
        values = ",\n".join("(" + ",".join(q(x) for x in r) + ")" for r in rows[i:i + chunk])
        yield f"{head}\n{values}\n{tail};"


def utc_day(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def merge_watches(views, chunk: int = 200) -> list[str]:
    """Write-frugal merge of Takeout views, keyed on the (video, day) counting unit.

    D1's free plan allows 100k rows written per day and a new watches row costs ~4
    (row + three indexes), so instead of one row per view:
      1. the earliest view of each (video, day) lends its time to an existing
         day-only 'history' row (1 write, none of the indexed columns change),
         unless that pair already has a timed row from another source;
      2. only pairs no source has seen yet get a new 'takeout' row.
    Extra views of the same video on the same day add nothing to the dashboard.
    """
    first = {}
    for vid, day, ts, hour, dow, product in sorted(views, key=lambda w: w[2]):
        first.setdefault((vid, day), (vid, day, ts, hour, dow, product))
    rows = list(first.values())
    out = []
    for i in range(0, len(rows), chunk):
        part = rows[i:i + chunk]
        vals = ",\n".join("(" + ",".join(q(x) for x in (vid, day, ts, hour, dow, product, f"t|{vid}|{ts}")) + ")"
                          for vid, day, ts, hour, dow, product in part)
        out.append(
            "UPDATE watches SET ts = v.column3, hour = v.column4, dow = v.column5\n"
            f"FROM (VALUES\n{vals}\n) AS v\n"
            "WHERE watches.video_id = v.column1 AND watches.day = v.column2\n"
            "  AND watches.source = 'history' AND watches.ts IS NULL\n"
            "  AND NOT EXISTS (SELECT 1 FROM watches w2 WHERE w2.video_id = v.column1 AND w2.day = v.column2 AND w2.ts IS NOT NULL);")
        # The history page files views under the UTC date, so a view whose local day
        # differs from its UTC day (after midnight east of UTC, late evening west of it)
        # sits on the wrong day there. Move that row to the local day (with its time)
        # instead of adding a second one.
        shifted = [r for r in part if r[2] and utc_day(r[2]) != r[1]]
        if shifted:
            evals = ",\n".join("(" + ",".join(q(x) for x in (vid, day, ts, hour, dow, utc_day(ts))) + ")"
                               for vid, day, ts, hour, dow, product in shifted)
            out.append(
                "UPDATE watches SET day = v.column2, ts = v.column3, hour = v.column4, dow = v.column5\n"
                f"FROM (VALUES\n{evals}\n) AS v\n"
                "WHERE watches.video_id = v.column1 AND watches.day = v.column6\n"
                "  AND watches.source = 'history' AND watches.ts IS NULL\n"
                "  AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.video_id = v.column1 AND w.day = v.column2);")
        out.append(
            "INSERT OR IGNORE INTO watches (video_id, day, ts, hour, dow, source, product, dedup_key)\n"
            "SELECT v.column1, v.column2, v.column3, v.column4, v.column5, 'takeout', v.column6, v.column7\n"
            f"FROM (VALUES\n{vals}\n) AS v\n"
            "WHERE NOT EXISTS (SELECT 1 FROM watches w WHERE w.video_id = v.column1 AND w.day = v.column2);")
    return out


def to_sql(data: Data) -> list[str]:
    out = []
    vids = [(vid, t, cid, ch) for vid, (t, cid, ch, _ts) in data.videos.items()]
    out += inserts("INSERT INTO videos (video_id, title, channel_id, channel_title) VALUES", vids,
                   "ON CONFLICT(video_id) DO UPDATE SET title = COALESCE(videos.title, excluded.title), "
                   "channel_id = COALESCE(videos.channel_id, excluded.channel_id), "
                   "channel_title = COALESCE(videos.channel_title, excluded.channel_title) "
                   # no-op upserts still count as row writes against D1's daily quota
                   "WHERE (videos.title IS NULL AND excluded.title IS NOT NULL) "
                   "OR (videos.channel_id IS NULL AND excluded.channel_id IS NOT NULL) "
                   "OR (videos.channel_title IS NULL AND excluded.channel_title IS NOT NULL)")
    out += merge_watches(data.watches)
    out += inserts("INSERT INTO likes (video_id, liked_at, day, source) VALUES",
                   [(*l, "takeout") for l in data.likes],
                   "ON CONFLICT(video_id) DO UPDATE SET liked_at = COALESCE(likes.liked_at, excluded.liked_at), "
                   "day = COALESCE(likes.day, excluded.day) WHERE likes.liked_at IS NULL")
    # Last word wins between like and dislike: Mi actividad has both events, newest last.
    out += inserts("INSERT INTO dislikes (video_id, ts, day, source) VALUES",
                   [(*d, "takeout") for d in sorted(data.dislikes, key=lambda d: d[1])],
                   "ON CONFLICT(video_id) DO UPDATE SET ts = excluded.ts, day = excluded.day "
                   "WHERE excluded.ts > COALESCE(dislikes.ts, 0)")
    out += inserts("INSERT OR IGNORE INTO saves (playlist_title, video_id, ts, day) VALUES", data.saves)
    subs = [(cid, title, ts, local(ts)[0] if ts else None, now)
            for cid, (title, ts, now) in data.subs.items()]
    out += inserts("INSERT INTO channels (channel_id, title, subscribed_at, subscribed_day, subscribed) VALUES", subs,
                   "ON CONFLICT(channel_id) DO UPDATE SET title = COALESCE(channels.title, excluded.title), "
                   "subscribed_at = MIN(COALESCE(channels.subscribed_at, excluded.subscribed_at), COALESCE(excluded.subscribed_at, channels.subscribed_at)), "
                   "subscribed_day = CASE WHEN excluded.subscribed_at < COALESCE(channels.subscribed_at, 9e18) THEN excluded.subscribed_day ELSE channels.subscribed_day END, "
                   "subscribed = COALESCE(excluded.subscribed, channels.subscribed) "
                   "WHERE (channels.title IS NULL AND excluded.title IS NOT NULL) "
                   "OR (excluded.subscribed_at IS NOT NULL AND excluded.subscribed_at < COALESCE(channels.subscribed_at, 9e18)) "
                   "OR (excluded.subscribed IS NOT NULL AND channels.subscribed IS NOT excluded.subscribed)")
    note = json.dumps({"watches": len(data.watches), "dislikes": len(data.dislikes),
                       "likes": len(data.likes), "saves": len(data.saves), "skipped": data.skipped})
    # Videos YouTube no longer serves (tombstoned as 'gone' by the enrichment) never
    # come back through an import.
    for t in ("watches", "likes", "dislikes", "saves"):
        out.append(f"DELETE FROM {t} WHERE video_id IN (SELECT video_id FROM videos WHERE meta_source = 'gone');")
    out.append(f"INSERT INTO sync_log (at, kind, items, note) VALUES "
               f"({int(datetime.now().timestamp() * 1000)}, 'takeout', {len(data.watches)}, {q(note)});")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help="Takeout folder(s) or .zip file(s)")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "import-takeout.sql")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--apply-local", action="store_true", help="load into the local dashboard (npm start)")
    g.add_argument("--apply", action="store_true", help="load into your Cloudflare D1 (npm run cloud)")
    args = ap.parse_args()
    args.out.parent.mkdir(exist_ok=True)

    print("Reading Takeout…")
    data = collect(args.paths)
    if not data.watches and not data.likes and not data.subs:
        sys.exit("No YouTube data found. Point me at the unzipped Takeout folder or the .zip files.")
    days = sorted({w[1] for w in data.watches})
    print(f"\n  {len(data.watches):,} views of {len({w[0] for w in data.watches}):,} videos"
          + (f", {days[0]} → {days[-1]}" if days else ""))
    print(f"  {len(data.likes):,} likes · {len(data.dislikes):,} dislikes · {len(data.saves):,} saved to playlists")
    print(f"  skipped: {data.skipped}")
    if data.unknown_verbs:
        top = sorted(data.unknown_verbs.items(), key=lambda kv: -kv[1])[:15]
        print(f"  ! unrecognised activity kinds (not imported): {top}")

    args.out.write_text("\n".join(to_sql(data)) + "\n", encoding="utf-8")
    print(f"\nSQL written to {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}")
    if args.apply:
        wrangler("d1", "execute", d1_name(), "--remote", "--yes", f"--file={args.out}")
    elif args.apply_local:
        # wrangler --local --file hangs on big files; write the SQLite file directly.
        db = local_db()
        with sqlite3.connect(db) as con:
            con.executescript(args.out.read_text(encoding="utf-8"))
        print(f"Loaded into {db.relative_to(ROOT)}")
    else:
        print("Load it with --apply-local (local dashboard) or --apply (Cloudflare).")


if __name__ == "__main__":
    main()
