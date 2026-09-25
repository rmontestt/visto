"""Copy what the LOCAL dashboard has and your Cloudflare D1 lacks, inside D1's daily quota.

    python ingest/push_prod.py              # plan only (reads, no writes)
    python ingest/push_prod.py --apply      # write up to today's budget
    python ingest/push_prod.py --apply --deploy --set-api-key

Big imports (years of Takeout, a first full import) are cheapest locally (`npm start`,
takeout_import.py --apply-local); this script brings the cloud deployment
(`npm run cloud`, worker/wrangler.local.jsonc) up to date with them. It reads production (reads are
cheap: 5M/day), diffs table by table and writes only the difference, in this order:

  1. schema      migrations 002 (themes, channels, dislikes) and 003 (drop comments)
  2. purge       rows of videos that are gone locally (deleted/private) + saves that
                 no longer exist locally (only Favorites is kept)
  3. watches     new rows, and rows whose day/time changed (Takeout merge)
  4. reactions   likes, dislikes, saves
  5. videos      metadata, topics and theme (drops the full pending index first;
                 migration 004 rebuilds it as a partial index once all are in)
  6. channels    avatars, subscriptions

D1's free plan allows 100k rows written per day across the whole account.
The budget is that minus what Cloudflare already counted today, minus a margin for
the extension and other projects; whatever does not fit is left for the next run. The
diff is recomputed every time, so running it again is always safe. Rows production
has and local does not (new views from the extension) are kept, never deleted.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

from visto_config import ROOT, account_id, d1_name, local_db as local_db_path, oauth_token, setting, wrangler as _wrangler

DAILY_LIMIT = 100_000
MARGIN = 10_000  # left for the extension, the cron and other projects on the account
CHUNK = 100

# Estimated D1 rows written per operation (row + each index entry it touches).
COST = {
    ("watches", "insert"): 4, ("watches", "update"): 1, ("watches", "move"): 3, ("watches", "delete"): 4,
    ("videos", "insert"): 2, ("videos", "update"): 1,
    ("likes", "insert"): 2, ("likes", "update"): 1, ("likes", "delete"): 2,
    ("dislikes", "insert"): 2, ("dislikes", "update"): 1, ("dislikes", "delete"): 2,
    ("saves", "insert"): 2, ("saves", "update"): 1, ("saves", "delete"): 2,
    ("channels", "insert"): 2, ("channels", "update"): 1,
}

TABLES = {
    # table: (key columns, data columns)
    "videos": (["video_id"], ["title", "channel_id", "channel_title", "duration_s", "category_id", "published_at",
                              "is_short", "topics", "theme", "meta_source", "meta_checked_at"]),
    "watches": (["dedup_key"], ["video_id", "day", "ts", "hour", "dow", "seconds", "source", "product"]),
    "likes": (["video_id"], ["liked_at", "day", "source"]),
    "dislikes": (["video_id"], ["ts", "day", "source"]),
    "saves": (["playlist_title", "video_id"], ["ts", "day"]),
    "channels": (["channel_id"], ["title", "handle", "avatar_url", "subscribed_at", "subscribed_day", "subscribed", "fetched_at"]),
}


# ---------- wrangler / Cloudflare ----------------------------------------------------

def wrangler(*args: str, capture=True) -> str:
    return _wrangler(*args, cloud=True, capture=capture)


def remote(sql: str) -> list[dict]:
    out = wrangler("d1", "execute", d1_name(), "--remote", "--json", "--command", sql)
    data = json.loads(out[out.index("["):])
    return data[0]["results"]


def remote_file(path: Path):
    wrangler("d1", "execute", d1_name(), "--remote", "--yes", f"--file={path}", capture=False)


def writes_today() -> int | None:
    """Rows written today (UTC) by every D1 database of the account."""
    tok, acc = oauth_token(), account_id()
    if not tok or not acc:
        return None
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    q = {"query": "query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){"
                  "d1AnalyticsAdaptiveGroups(limit:100,filter:{date:$d}){sum{rowsWritten}}}}}",
         "variables": {"a": acc, "d": today}}
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=json.dumps(q).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
        groups = body["data"]["viewer"]["accounts"][0]["d1AnalyticsAdaptiveGroups"]
        return sum(g["sum"]["rowsWritten"] for g in groups)
    except Exception as e:  # noqa: BLE001 - usage is advisory, the caller decides
        print(f"  (could not read today's D1 usage: {e})")
        return None


# ---------- reading both sides ---------------------------------------------------------

def local_db() -> sqlite3.Connection:
    return sqlite3.connect(local_db_path())


def read_local(con, table) -> dict[tuple, tuple]:
    keys, cols = TABLES[table]
    return {r[:len(keys)]: r[len(keys):] for r in con.execute(f"SELECT {', '.join(keys + cols)} FROM {table}")}


def read_remote(table, page=10_000) -> dict[tuple, tuple]:
    keys, cols = TABLES[table]
    out, last = {}, 0
    while True:
        rows = remote(f"SELECT rowid AS _r, {', '.join(keys + cols)} FROM {table} "
                      f"WHERE rowid > {last} ORDER BY rowid LIMIT {page}")
        for r in rows:
            out[tuple(r[k] for k in keys)] = tuple(r[c] for c in cols)
        if len(rows) < page:
            return out
        last = rows[-1]["_r"]


# ---------- SQL -------------------------------------------------------------------------

def lit(x) -> str:
    if x is None:
        return "NULL"
    if isinstance(x, (int, float)):
        return str(x)
    return "'" + str(x).replace("'", "''") + "'"


def upserts(table, rows: list[tuple], keep_remote_values=True) -> list[str]:
    """INSERT ... ON CONFLICT DO UPDATE, CHUNK rows per statement. Local NULLs never
    wipe a value production already has."""
    keys, cols = TABLES[table]
    sets = ", ".join(f"{c} = COALESCE(excluded.{c}, {table}.{c})" if keep_remote_values else f"{c} = excluded.{c}"
                     for c in cols)
    out = []
    for i in range(0, len(rows), CHUNK):
        vals = ",\n".join("(" + ", ".join(lit(x) for x in r) + ")" for r in rows[i:i + CHUNK])
        out.append(f"INSERT INTO {table} ({', '.join(keys + cols)}) VALUES\n{vals}\n"
                   f"ON CONFLICT({', '.join(keys)}) DO UPDATE SET {sets};")
    return out


def deletes(table, keys: list[tuple]) -> list[str]:
    kcols = TABLES[table][0]
    out = []
    for i in range(0, len(keys), CHUNK):
        part = keys[i:i + CHUNK]
        if len(kcols) == 1:
            out.append(f"DELETE FROM {table} WHERE {kcols[0]} IN ({', '.join(lit(k[0]) for k in part)});")
        else:
            out.append(f"DELETE FROM {table} WHERE ({', '.join(kcols)}) IN (VALUES "
                       + ", ".join("(" + ", ".join(lit(x) for x in k) + ")" for k in part) + ");")
    return out


# ---------- plan ----------------------------------------------------------------------

class Plan:
    def __init__(self):
        self.steps: list[tuple[str, str, int]] = []  # (phase, sql, estimated writes)

    def add(self, phase, stmts, cost_each_row, rows_per_stmt):
        for i, s in enumerate(stmts):
            n = min(CHUNK, rows_per_stmt - i * CHUNK) if rows_per_stmt else 1
            self.steps.append((phase, s, n * cost_each_row))

    def total(self, phase=None):
        return sum(c for p, _, c in self.steps if phase is None or p == phase)


def schema_state() -> dict:
    r = remote("SELECT (SELECT COUNT(*) FROM pragma_table_info('videos') WHERE name = 'theme') AS has_theme, "
               "(SELECT COUNT(*) FROM sqlite_master WHERE name = 'comments') AS has_comments, "
               "(SELECT sql FROM sqlite_master WHERE name = 'idx_videos_pending') AS vidx")[0]
    return r


def diff(table, loc, rem):
    """(new rows, changed rows) as full tuples key + cols."""
    new, changed = [], []
    for k, v in loc.items():
        if k not in rem:
            new.append(k + v)
        elif rem[k] != v:
            changed.append(k + v)
    return new, changed


def build(con) -> tuple[Plan, dict]:
    plan, info = Plan(), {}
    gone = {r[0] for r in con.execute("SELECT video_id FROM videos WHERE meta_source = 'gone'")}

    # 2. purge: gone videos everywhere, saves that no longer exist locally
    rem_w = read_remote("watches")
    loc_w = read_local(con, "watches")
    kill = [k for k, v in rem_w.items() if k not in loc_w and v[0] in gone]
    plan.add("purge", deletes("watches", kill), COST["watches", "delete"], len(kill))
    info["watches only in production (kept)"] = sum(1 for k, v in rem_w.items() if k not in loc_w and v[0] not in gone)
    rems = {}
    for t in ("likes", "dislikes", "saves"):
        rem = read_remote(t) if t != "dislikes" or schema_ok["has_theme"] else {}
        rems[t] = rem
        loc = read_local(con, t)
        vid = (lambda k: k[1]) if t == "saves" else (lambda k: k[0])
        kill = [k for k in rem if k not in loc and (t == "saves" or vid(k) in gone)]
        plan.add("purge", deletes(t, kill), COST[t, "delete"], len(kill))

    # 3. watches: live rows keep the larger measured seconds production may have
    new, changed = diff("watches", loc_w, rem_w)
    moved = [r for r in changed if rem_w[r[:1]][1] != r[2]]  # day changed: day index too
    same_day = [r for r in changed if rem_w[r[:1]][1] == r[2]
                and not (r[0].startswith("l|") and (rem_w[r[:1]][5] or 0) >= (r[6] or 0))]
    plan.add("watches", upserts("watches", new), COST["watches", "insert"], len(new))
    plan.add("watches", upserts("watches", moved, keep_remote_values=False), COST["watches", "move"], len(moved))
    plan.add("watches", upserts("watches", same_day), COST["watches", "update"], len(same_day))
    info["watches: new / moved to another day / time filled in"] = f"{len(new):,} / {len(moved):,} / {len(same_day):,}"

    # 4. reactions
    for t in ("likes", "dislikes", "saves"):
        new, changed = diff(t, read_local(con, t), rems[t])
        plan.add("reactions", upserts(t, new), COST[t, "insert"], len(new))
        plan.add("reactions", upserts(t, changed), COST[t, "update"], len(changed))

    # 5. videos (the full pending index is dropped before, see run())
    rem_v = read_remote("videos") if schema_ok["has_theme"] else read_remote_videos_old()
    new, changed = diff("videos", read_local(con, "videos"), rem_v)
    plan.add("videos", upserts("videos", new), COST["videos", "insert"], len(new))
    plan.add("videos", upserts("videos", changed), COST["videos", "update"], len(changed))

    # 6. channels
    rem_c = read_remote("channels") if schema_ok["has_theme"] else {}
    new, changed = diff("channels", read_local(con, "channels"), rem_c)
    plan.add("channels", upserts("channels", new), COST["channels", "insert"], len(new))
    plan.add("channels", upserts("channels", changed), COST["channels", "update"], len(changed))
    return plan, info


def read_remote_videos_old():
    """Before migration 002 production has no topics/theme columns: read them as NULL."""
    keys, cols = TABLES["videos"]
    saved = TABLES["videos"]
    TABLES["videos"] = (keys, [c for c in cols if c not in ("topics", "theme")])
    try:
        rows = read_remote("videos")
    finally:
        TABLES["videos"] = saved
    return {k: v[:7] + (None, None) + v[7:] for k, v in rows.items()}


schema_ok: dict = {}

LEDGER = ROOT / "data" / "push_ledger.json"


def read_ledger() -> dict:
    """What this script wrote on the current UTC day (D1's quota day)."""
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    try:
        led = json.loads(LEDGER.read_text(encoding="utf-8"))
        if led.get("day") == today:
            return led
    except (FileNotFoundError, ValueError):
        pass
    return {"day": today, "baseline": 0, "written": 0}


def save_ledger(led: dict):
    LEDGER.parent.mkdir(exist_ok=True)
    LEDGER.write_text(json.dumps(led, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write to production (default: plan only)")
    ap.add_argument("--budget", type=int, help="max rows to write now (default: today's quota left minus a margin)")
    ap.add_argument("--deploy", action="store_true", help="deploy the Worker once the schema is in place")
    ap.add_argument("--set-api-key", action="store_true",
                    help="set YOUTUBE_API_KEY from .env once the videos are synced (turns on hourly API enrichment)")
    args = ap.parse_args()

    con = local_db()
    print("Production schema...")
    schema_ok.update(schema_state())
    # Cloudflare's usage figures lag behind by a while, so a second run the same day
    # would still see the morning's number: also count what this script wrote today.
    reported = writes_today()
    ledger = read_ledger()
    used = reported if reported is None else max(reported, ledger["baseline"] + ledger["written"]) if ledger["written"] else reported
    if reported is not None and not ledger["written"]:
        ledger["baseline"] = reported
    if args.budget is not None:
        budget = args.budget
    elif used is None:
        budget = 50_000
        print("  today's usage unknown: budget 50,000 (pass --budget to override)")
    else:
        budget = max(0, DAILY_LIMIT - MARGIN - used)
    print(f"  D1 rows written today (UTC, whole account): {'?' if used is None else f'{used:,}'}  ->  budget {budget:,}")

    # 1. schema first: everything else depends on it and it costs almost nothing
    schema = []
    if not schema_ok["has_theme"]:
        schema.append(ROOT / "worker/migrations/002_themes.sql")
    if schema_ok["has_comments"]:
        schema.append(ROOT / "worker/migrations/003_drop_comments.sql")
    if schema and args.apply:
        for f in schema:
            print(f"  applying {f.name}")
            remote_file(f)
        schema_ok.update(schema_state())
    elif schema:
        print(f"  pending migrations: {', '.join(f.name for f in schema)}")

    print("Reading production and local tables (reads only)...")
    plan, info = build(con)
    for k, v in info.items():
        print(f"  {k}: {v:,}" if isinstance(v, int) else f"  {k}: {v}")
    phases = ["purge", "watches", "reactions", "videos", "channels"]
    print("\nEstimated rows written per phase:")
    for p in phases:
        print(f"  {p:<10} {plan.total(p):>8,}")
    print(f"  {'total':<10} {plan.total():>8,}   (budget now {budget:,})")

    # Take whole steps in order until the budget runs out.
    take, spent = [], 0
    for step in plan.steps:
        if spent + step[2] > budget:
            break
        take.append(step)
        spent += step[2]
    videos_done = all(s in take for s in plan.steps if s[0] == "videos")
    left = plan.total() - spent
    print(f"\nThis run: {len(take)} of {len(plan.steps)} statements, ~{spent:,} rows"
          + (f"; ~{left:,} left for the next run" if left else "; that completes the sync"))

    if not args.apply:
        print("\nPlan only. Run again with --apply to write it.")
        return

    if take:
        sql = []
        if any(s[0] == "videos" for s in take) and "WHERE" not in (schema_ok.get("vidx") or "WHERE"):
            # Updating ~48k videos under the full index would triple the writes.
            sql.append("DROP INDEX IF EXISTS idx_videos_pending;")
        sql += [s[1] for s in take]
        out = ROOT / "data" / f"push-{dt.datetime.now():%Y%m%dT%H%M%S}.sql"
        out.write_text("\n".join(sql) + "\n", encoding="utf-8")
        print(f"Writing {out.name} ({out.stat().st_size / 1e6:.1f} MB)...")
        remote_file(out)
        ledger["written"] += spent
        save_ledger(ledger)
    if videos_done and "WHERE" not in (remote("SELECT COALESCE((SELECT sql FROM sqlite_master WHERE name = 'idx_videos_pending'), '') AS s")[0]["s"]):
        print("Videos complete: rebuilding the pending indexes as partial (migration 004)")
        remote_file(ROOT / "worker/migrations/004_partial_pending.sql")

    if args.deploy:
        if schema_ok["has_theme"] and not schema_ok["has_comments"]:
            print("Deploying the Worker...")
            wrangler("deploy", capture=False)
        else:
            print("Not deploying: the schema is not in place yet.")
    if args.set_api_key:
        if not videos_done:
            print("Not setting YOUTUBE_API_KEY yet: videos are still syncing (the cron would enrich them twice).")
        else:
            key = setting("YOUTUBE_API_KEY")
            if not key:
                sys.exit("YOUTUBE_API_KEY missing (worker/.dev.vars or .env)")
            print("Setting YOUTUBE_API_KEY...")
            cmd = ["node", str(ROOT / "node_modules" / "wrangler" / "bin" / "wrangler.js"), "secret", "put",
                   "YOUTUBE_API_KEY", "--config", str(ROOT / "worker" / "wrangler.local.jsonc")]
            subprocess.run(cmd, cwd=ROOT, input=key, text=True, check=True)
    print("Done. Run it again for whatever is left; it only writes the difference.")


if __name__ == "__main__":
    main()
