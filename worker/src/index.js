import { json, hmacHex, safeEqual } from './util.js';
import { handleIngest } from './ingest.js';
import { summary, calendar, day, search, videos, rewatched, saves, themesByYear, subs, channels } from './stats.js';
import { enrich } from './enrich.js';

const COOKIE = 'visto_session';
const SESSION_DAYS = 90;
const API_CACHE_TTL_S = 600;
const MEMO = new Map(); // url -> { at, body }, per isolate

export default {
  async fetch(request, env) {
    const res = await route(request, env);
    // Personal data: keep every page out of search engines, public or not.
    const out = new Response(res.body, res);
    out.headers.set('x-robots-tag', 'noindex, nofollow');
    if (/\.(js|css|html)$|\/$/.test(new URL(request.url).pathname)) out.headers.set('cache-control', 'no-cache');
    return out;
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await enrich(env);
      console.log('enrich', JSON.stringify(r));
      // Keep sync_log small: pings are hourly, only recent ones matter.
      await env.DB.prepare(`DELETE FROM sync_log WHERE at < ?1`).bind(Date.now() - 60 * 86_400_000).run();
    })());
  },
};

async function route(request, env) {
  {
    const url = new URL(request.url);
    const { pathname } = url;

    // Extension -> Worker. Bearer token, never the dashboard cookie.
    if (pathname === '/api/ingest') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const auth = request.headers.get('authorization') || '';
      if (!env.INGEST_TOKEN || !(await safeEqual(auth.replace(/^Bearer\s+/i, ''), env.INGEST_TOKEN))) {
        return json({ error: 'unauthorized' }, 401);
      }
      return handleIngest(request, env);
    }

    if (pathname === '/login') {
      if (request.method === 'POST') return login(request, env);
      return loginPage();
    }
    if (pathname === '/logout') {
      return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (pathname === '/favicon.svg') return env.ASSETS.fetch(request);

    // PUBLIC_DASHBOARD=1 (wrangler.jsonc vars) opens the read-only dashboard to anyone;
    // ingest keeps its bearer token either way.
    if (env.PUBLIC_DASHBOARD !== '1' && !(await hasSession(request, env))) {
      if (pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      return Response.redirect(new URL('/login', url), 303);
    }

    if (pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      const handler = {
        '/api/summary': summary, '/api/calendar': calendar, '/api/day': day, '/api/search': search,
        '/api/videos': videos, '/api/rewatched': rewatched, '/api/saves': saves, '/api/themes': themesByYear, '/api/subs': subs,
        '/api/channels': channels,
      }[pathname];
      if (!handler) return json({ error: 'not found' }, 404);
      // An "all time" summary reads ~1M D1 rows and the daily read quota is shared with
      // other projects on the account, so answers are cached for API_CACHE_TTL_S. Only
      // when public: then every viewer sees the same data and the URL is a safe key.
      // Two layers: the isolate's memory (always works) and the Cache API (a no-op on
      // *.workers.dev, useful if a custom domain is added later).
      // Not on wrangler dev: a stale 10-minute answer there only hides code changes.
      const cacheable = env.PUBLIC_DASHBOARD === '1' && url.hostname !== 'localhost';
      const cache = caches.default;
      if (cacheable) {
        const m = MEMO.get(url.href);
        if (m && Date.now() - m.at < API_CACHE_TTL_S * 1000) {
          return new Response(m.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${API_CACHE_TTL_S}`, 'x-cache': 'memo' } });
        }
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      try {
        const res = await handler(url, env);
        if (cacheable && res.ok) {
          const body = await res.text();
          if (MEMO.size > 200) MEMO.delete(MEMO.keys().next().value);
          MEMO.set(url.href, { at: Date.now(), body });
          const out = new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${API_CACHE_TTL_S}` } });
          await cache.put(request, out.clone()).catch(() => {});
          return out;
        }
        return res;
      } catch (err) {
        console.error(pathname, err);
        return json({ error: 'internal' }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
}

async function sign(env, exp) {
  return hmacHex(env.SESSION_SECRET, `session:${exp}`);
}

async function hasSession(request, env) {
  // Local `wrangler dev` only (.dev.vars); never set this as a production secret.
  if (env.DEV_NO_AUTH === '1' && new URL(request.url).hostname === 'localhost') return true;
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
  if (!raw || !env.SESSION_SECRET) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env, exp));
}

async function login(request, env) {
  const form = await request.formData().catch(() => null);
  const password = form?.get('password');
  if (!env.DASHBOARD_PASSWORD || !(await safeEqual(String(password ?? ''), env.DASHBOARD_PASSWORD))) {
    await new Promise(r => setTimeout(r, 600)); // blunt brute force
    return loginPage(true);
  }
  const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
  const cookie = `${COOKIE}=${exp}.${await sign(env, exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } });
}

function loginPage(failed = false) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visto · Sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--bg:#0f0f0f;--card:#212121;--ink:#f1f1f1;--ink2:#aaa;--line:#303030;--field:#121212}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f9f9f9;--card:#fff;--ink:#0f0f0f;--ink2:#606060;--line:#d3d3d3;--field:#fff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:14px/1.5 Roboto,Arial,sans-serif;padding:16px}
form{width:min(400px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:36px 32px 32px;display:flow-root}
.logo{display:flex;align-items:center;gap:6px;margin-bottom:22px}
.logo svg{width:40px;height:28px}
.logo b{font-size:28px;font-weight:700;letter-spacing:-.06em}
h1{font-size:22px;font-weight:400;margin:0 0 4px}
p{color:var(--ink2);margin:0 0 24px}
label{display:block;font-size:12px;color:var(--ink2);margin-bottom:6px}
input{width:100%;font:inherit;font-size:16px;padding:12px 14px;border:1px solid var(--line);background:var(--field);color:var(--ink);border-radius:8px}
input:focus{outline:2px solid #3ea6ff;border-color:transparent}
button{margin-top:18px;height:40px;padding:0 20px;font:500 14px Roboto,Arial,sans-serif;border:0;border-radius:20px;background:var(--ink);color:var(--bg);cursor:pointer;float:right}
button:hover{opacity:.88}
.err{color:#ff4e45;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/login">
  <div class="logo"><svg viewBox="0 0 30 21" aria-hidden="true"><rect width="30" height="21" rx="6" fill="#ff0033"/><path d="M12 6.2v8.6l7.2-4.3z" fill="#fff"/></svg><b>Visto</b></div>
  <h1>Sign in</h1>
  <p>to see your YouTube history</p>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
  ${failed ? '<div class="err" role="alert">Wrong password.</div>' : ''}
  <button type="submit">Next</button>
</form></body></html>`;
  return new Response(html, { status: failed ? 401 : 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
