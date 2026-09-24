"""Where things are, shared by the ingest scripts. Nothing personal lives in code:

  * worker/.dev.vars        local dashboard settings (TZ, INGEST_TOKEN, YOUTUBE_API_KEY), from `npm start`
  * worker/wrangler.local.jsonc  your Cloudflare deployment (Worker name, D1 id, TZ), from `npm run cloud`
  * .env                    cloud secrets and optional TAKEOUT_DIR / YOUTUBE_API_KEY

All three are git-ignored.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "worker" / "wrangler.jsonc"
CLOUD = ROOT / "worker" / "wrangler.local.jsonc"
DEV_VARS = ROOT / "worker" / ".dev.vars"
ENV = ROOT / ".env"
LOCAL_D1 = ROOT / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"


def read_vars(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$", line)
        if m:
            out[m[1]] = m[2].strip()
    return out


def setting(name: str, default: str | None = None) -> str | None:
    """Environment variable, then .env, then worker/.dev.vars."""
    return os.environ.get(name) or read_vars(ENV).get(name) or read_vars(DEV_VARS).get(name) or default


def jsonc(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*[\s\S]*?\*/', lambda m: m[1] or "", text)
    return json.loads(text)


def cloud_config() -> dict:
    if not CLOUD.exists():
        sys.exit("No Cloudflare deployment configured yet: run `npm run cloud` first (or use the --local options).")
    return jsonc(CLOUD)


def tz_name() -> str:
    """The time zone days and hours are counted in: local settings, then the cloud config."""
    tz = read_vars(DEV_VARS).get("TZ")
    if not tz and CLOUD.exists():
        tz = jsonc(CLOUD).get("vars", {}).get("TZ")
    return tz or os.environ.get("TZ") or "UTC"


def local_db() -> Path:
    """The local dashboard's SQLite file (the most recently used one if there are several)."""
    files = [p for p in LOCAL_D1.glob("*.sqlite") if p.name != "metadata.sqlite"] if LOCAL_D1.exists() else []
    if not files:
        sys.exit("No local database yet: run `npm start` once to create it.")
    return max(files, key=lambda p: p.stat().st_mtime)


def wrangler(*args: str, cloud: bool = True, capture: bool = False) -> str:
    """Run the pinned wrangler with the right config. Retries the odd transient
    'account not valid' (code 7403) the Cloudflare API sometimes answers once."""
    cmd = ["node", str(ROOT / "node_modules" / "wrangler" / "bin" / "wrangler.js"), *args,
           "--config", str(CLOUD if cloud else TEMPLATE)]
    for attempt in range(3):
        r = subprocess.run(cmd, cwd=ROOT, capture_output=capture, text=True, encoding="utf-8")
        if r.returncode == 0:
            return r.stdout if capture else ""
        err = (r.stdout or "") + (r.stderr or "")
        if "7403" not in err or attempt == 2:
            sys.exit(f"wrangler {' '.join(args[:3])} failed" + (f":\n{err[-2000:]}" if err else ""))
    return ""


def d1_name() -> str:
    return cloud_config()["d1_databases"][0]["database_name"]


def oauth_token() -> str | None:
    """wrangler's OAuth token (after `wrangler login`), for the GraphQL usage query."""
    for base in (os.environ.get("APPDATA"), os.environ.get("XDG_CONFIG_HOME"), str(Path.home() / ".config"),
                 str(Path.home() / "Library" / "Preferences")):
        if not base:
            continue
        for sub in ("xdg.config/.wrangler/config/default.toml", ".wrangler/config/default.toml"):
            f = Path(base) / sub
            if f.exists():
                m = re.search(r'oauth_token\s*=\s*"([^"]+)"', f.read_text(encoding="utf-8"))
                if m:
                    return m[1]
    return os.environ.get("CLOUDFLARE_API_TOKEN")


def account_id() -> str | None:
    """CLOUDFLARE_ACCOUNT_ID, the config's account_id, or the only account the login can see."""
    acc = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or (jsonc(CLOUD).get("account_id") if CLOUD.exists() else None)
    if acc:
        return acc
    tok = oauth_token()
    if not tok:
        return None
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts",
                                 headers={"Authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            accounts = json.load(r).get("result", [])
    except OSError:
        return None
    return accounts[0]["id"] if len(accounts) == 1 else None
