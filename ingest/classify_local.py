"""Enrich the LOCAL dashboard's database through the YouTube Data API, in one go.

    python ingest/classify_local.py [--db path.sqlite] [--limit N]

Needs YOUTUBE_API_KEY (worker/.dev.vars or .env). `npm start` already enriches while
it runs (2,000 videos every 5 minutes); this script does everything at once.

Videos with meta_checked_at IS NULL get duration, category, publish date, topics and
the Visto theme (same rules as worker/src/themes.js, from worker/src/themes.json);
channels referenced by videos or subscriptions get their official avatar and handle.
A Cloudflare deployment does the same slowly from the hourly cron (worker/src/enrich.js)
to stay inside D1's daily write quota.
Quota cost: 1 unit per 50 videos or 50 channels (10k units/day free).
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from visto_config import ROOT, local_db, setting

THEMES = json.loads((ROOT / "worker" / "src" / "themes.json").read_text(encoding="utf-8"))
API = "https://www.googleapis.com/youtube/v3/"


def api_key() -> str:
    return setting("YOUTUBE_API_KEY") or sys.exit("YOUTUBE_API_KEY missing: add it to worker/.dev.vars or .env (see README).")


def theme_for(topics: list[str], category_id) -> str:
    s = set(topics)
    for t in THEMES["themes"]:
        if any(x in s for x in t["topics"]):
            return t["id"]
    for t in THEMES["themes"]:
        if category_id is not None and int(category_id) in t["categories"]:
            return t["id"]
    return THEMES["fallback"]["id"]


def iso_duration(s: str | None) -> int | None:
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", s or "")
    if not m:
        return None
    secs = int(m[1] or 0) * 86400 + int(m[2] or 0) * 3600 + int(m[3] or 0) * 60 + int(m[4] or 0)
    return secs or None


def get(endpoint: str, params: dict, key: str) -> dict:
    url = API + endpoint + "?" + urllib.parse.urlencode({**params, "key": key})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 403:
                sys.exit(f"API refused ({e.code}): {e.read()[:300]!r}")  # quota or key
            time.sleep(2 ** attempt)
        except OSError:
            time.sleep(2 ** attempt)
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    key = api_key()
    con = sqlite3.connect(args.db or local_db())
    now = int(time.time() * 1000)

    # ---- videos
    ids = [r[0] for r in con.execute("SELECT video_id FROM videos WHERE meta_checked_at IS NULL ORDER BY rowid DESC")]
    if args.limit:
        ids = ids[: args.limit]
    batches = [ids[i:i + 50] for i in range(0, len(ids), 50)]
    fields = "items(id,snippet(title,channelId,channelTitle,categoryId,publishedAt),contentDetails(duration),topicDetails(topicCategories))"

    def fetch_videos(batch):
        return batch, get("videos", {"part": "snippet,contentDetails,topicDetails", "id": ",".join(batch), "fields": fields}, key)

    done = gone = 0
    with ThreadPoolExecutor(6) as pool:
        for batch, data in pool.map(fetch_videos, batches):
            found = set()
            for it in data.get("items", []):
                found.add(it["id"])
                s = it.get("snippet", {})
                topics = [urllib.parse.unquote(re.sub(r"^.*/wiki/", "", t)) for t in it.get("topicDetails", {}).get("topicCategories", [])]
                cat = int(s["categoryId"]) if s.get("categoryId") else None
                con.execute("""UPDATE videos SET title = ?, channel_id = ?, channel_title = ?, duration_s = ?, category_id = ?,
                                 published_at = ?, topics = ?, theme = ?, meta_source = 'api', meta_checked_at = ? WHERE video_id = ?""",
                            (s.get("title"), s.get("channelId"), s.get("channelTitle"), iso_duration(it.get("contentDetails", {}).get("duration")),
                             cat, s.get("publishedAt"), json.dumps(topics) if topics else None, theme_for(topics, cat), now, it["id"]))
                done += 1
            for vid in batch:
                if vid not in found:
                    con.execute("UPDATE videos SET meta_source = 'gone', meta_checked_at = ? WHERE video_id = ?", (now, vid))
                    for t in ("watches", "likes", "dislikes", "saves"):  # gone videos leave the dashboard
                        con.execute(f"DELETE FROM {t} WHERE video_id = ?", (vid,))
                    gone += 1
            con.commit()
            print(f"\r  videos: {done:,} enriched, {gone:,} gone / {len(ids):,}", end="", flush=True)
    print()

    # ---- channels: every channel we have seen, plus subscriptions
    con.execute("""INSERT OR IGNORE INTO channels (channel_id, title)
                   SELECT channel_id, MAX(channel_title) FROM videos WHERE channel_id LIKE 'UC%' GROUP BY channel_id""")
    cids = [r[0] for r in con.execute("SELECT channel_id FROM channels WHERE fetched_at IS NULL")]
    cbatches = [cids[i:i + 50] for i in range(0, len(cids), 50)]

    def fetch_channels(batch):
        return batch, get("channels", {"part": "snippet", "id": ",".join(batch),
                                        "fields": "items(id,snippet(title,customUrl,thumbnails(default(url),medium(url))))"}, key)

    got = 0
    with ThreadPoolExecutor(6) as pool:
        for batch, data in pool.map(fetch_channels, cbatches):
            for it in data.get("items", []):
                s = it.get("snippet", {})
                th = s.get("thumbnails", {})
                avatar = (th.get("medium") or th.get("default") or {}).get("url")
                con.execute("UPDATE channels SET title = COALESCE(?, title), handle = ?, avatar_url = ?, fetched_at = ? WHERE channel_id = ?",
                            (s.get("title"), s.get("customUrl"), avatar, now, it["id"]))
                got += 1
            for cid in batch:  # terminated channels: stop asking
                con.execute("UPDATE channels SET fetched_at = ? WHERE channel_id = ? AND fetched_at IS NULL", (now, cid))
            con.commit()
            print(f"\r  channels: {got:,} / {len(cids):,}", end="", flush=True)
    print()

    print("  themes:", con.execute("""SELECT theme, COUNT(*) FROM videos WHERE theme IS NOT NULL
                                      GROUP BY theme ORDER BY 2 DESC""").fetchall())


if __name__ == "__main__":
    main()
