"""Import every new Google Takeout that lands in your Takeout folder, exactly once.

    python ingest/takeout_watch.py [--folder PATH] [--local] [--dry-run]

The folder is where Takeout exports land (for example your Google Drive for desktop
"Takeout" folder); pass --folder or set TAKEOUT_DIR in .env.

--local loads into the local dashboard instead of your Cloudflare D1.

Meant to run on a schedule (Task Scheduler, cron, launchd). A Takeout arrives as several
zips sharing one export id (takeout-20260923T171648Z-1-001.zip, -1-002.zip, ...);
a group is imported once every part has stopped changing, so a half-synced Drive
upload is never read. Imported ids are remembered in data/takeout_state.json.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from visto_config import ROOT, setting

STATE = ROOT / "data" / "takeout_state.json"
LOG = ROOT / "data" / "takeout_watch.log"
EXPORT_RE = re.compile(r"^takeout-(\d{8}T\d{6}Z)-.*\.zip$", re.I)
STABLE_FOR_S = 15 * 60  # Drive for desktop keeps touching files while syncing


def log(msg: str):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"imported": {}}


def save_state(state: dict):
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", type=Path, default=Path(setting("TAKEOUT_DIR")) if setting("TAKEOUT_DIR") else None)
    ap.add_argument("--local", action="store_true", help="load into the local dashboard (npm start)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.folder is None:
        sys.exit("Where do your Takeout exports land? Pass --folder or set TAKEOUT_DIR in .env.")
    if not args.folder.exists():
        log(f"folder not available: {args.folder} (Drive not mounted?)")
        return 0

    groups: dict[str, list[Path]] = {}
    for f in args.folder.iterdir():
        m = EXPORT_RE.match(f.name)
        if m and f.is_file():
            groups.setdefault(m.group(1), []).append(f)

    state = load_state()
    now = time.time()
    todo = []
    for export_id, files in sorted(groups.items()):
        if export_id in state["imported"]:
            continue
        newest = max(f.stat().st_mtime for f in files)
        if now - newest < STABLE_FOR_S:
            log(f"{export_id}: still syncing ({len(files)} parts), will retry")
            continue
        todo.append((export_id, sorted(files)))

    if not todo:
        log("nothing new")
        return 0

    status = 0
    for export_id, files in todo:
        log(f"{export_id}: importing {len(files)} zip(s)")
        cmd = [sys.executable, "-X", "utf8", str(ROOT / "ingest" / "takeout_import.py"), *map(str, files),
               "--out", str(ROOT / "data" / f"import-{export_id}.sql")]
        if not args.dry_run:
            cmd.append("--apply-local" if args.local else "--apply")
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        for line in (r.stdout + r.stderr).splitlines():
            if line.strip():
                log(f"   {line}")
        if r.returncode == 0 and not args.dry_run:
            state["imported"][export_id] = {"at": datetime.now().isoformat(timespec="seconds"),
                                            "files": [f.name for f in files]}
            save_state(state)
        elif r.returncode != 0:
            log(f"{export_id}: FAILED (exit {r.returncode}), will retry next run")
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
