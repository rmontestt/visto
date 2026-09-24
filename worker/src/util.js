export const DAY_MS = 86_400_000;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Local calendar parts of an epoch-ms instant in `tz`. dow: 0 = Monday. */
export function localParts(ms, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), dow: DOW[p.weekday] };
}

export const todayLocal = tz => localParts(Date.now(), tz).day;

/** Shift a YYYY-MM-DD string by n days (calendar arithmetic, TZ-free). */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isVideoId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{11}$/.test(s);

export function clampStr(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
}

const enc = new TextEncoder();

export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (compares HMACs so lengths never leak). */
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const k = 'visto-compare';
  const [x, y] = await Promise.all([hmacHex(k, a), hmacHex(k, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
