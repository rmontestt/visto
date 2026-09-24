#!/usr/bin/env node
// Visto command line. No dependencies beyond the pinned wrangler in node_modules.
//
//   npm start                  local dashboard on http://localhost:8787 (no account needed)
//   npm run connect [-- cloud] print the extension's connection code again
//   npm run cloud              create / update your own deployment on Cloudflare
//   npm run wrangler -- ...    any wrangler command with the right --config
//
// On Windows, if PowerShell refuses `npm` (npm.ps1 blocked), type `npm.cmd` instead
// (`npm.cmd start`), or call this file directly: `node scripts/visto.mjs start`.
//
// Local mode keeps everything on this computer: the extension sends to localhost, the
// data lives in .wrangler/state, and this script triggers the metadata enrichment the
// cron would run in the cloud. Cloud mode writes worker/wrangler.local.jsonc (your
// Worker name, D1 id, time zone) and keeps its secrets in .env; both are git-ignored.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TEMPLATE = join(ROOT, 'worker', 'wrangler.jsonc');
const CLOUD = join(ROOT, 'worker', 'wrangler.local.jsonc');
const DEV_VARS = join(ROOT, 'worker', '.dev.vars');
const ENV = join(ROOT, '.env');
const PERSIST = join(ROOT, '.wrangler', 'state');
const PORT = Number(process.env.VISTO_PORT) || 8787;
const LOCAL_URL = `http://localhost:${PORT}`;
const ENRICH_EVERY_MS = 5 * 60_000;

// ---------- small helpers ---------------------------------------------------------

const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const systemTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const connectionCode = (url, t) => `visto:${Buffer.from(JSON.stringify({ u: url, t })).toString('base64url')}`;

function readVars(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .filter(l => /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

function writeVars(path, vars, header) {
  const body = Object.entries(vars).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(path, `${header ? `# ${header}\n` : ''}${body}\n`);
}

function wrangler(args, { config = TEMPLATE, capture = false, input } = {}) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args, '--config', config], {
    cwd: ROOT, encoding: 'utf8', input, stdio: capture || input != null ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });
  if (r.status !== 0) {
    if (capture || input != null) process.stderr.write(`${r.stdout || ''}${r.stderr || ''}`);
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed`);
  }
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function needInstall() {
  if (!existsSync(WRANGLER)) {
    console.error('wrangler is not installed yet: run `npm install` first (`npm.cmd install` on Windows if `npm` gives an error).');
    process.exit(1);
  }
}

function printConnect(url, t) {
  console.log(`\n  Dashboard:        ${url}`);
  console.log('  Connection code (paste it in the Visto extension popup):\n');
  console.log(`  ${connectionCode(url, t)}\n`);
}

// ---------- local ---------------------------------------------------------------

function localVars() {
  const vars = readVars(DEV_VARS);
  const fromEnv = readVars(ENV);
  const merged = {
    DEV_NO_AUTH: '1', // no login on localhost
    TZ: systemTz(),
    ENRICH_API_CALLS: '40', // no write quota locally: enrich as fast as the API allows
    ENRICH_CHANNEL_CALLS: '20',
    ...vars,
    INGEST_TOKEN: vars.INGEST_TOKEN || fromEnv.INGEST_TOKEN || token(),
  };
  if (!merged.YOUTUBE_API_KEY && fromEnv.YOUTUBE_API_KEY) merged.YOUTUBE_API_KEY = fromEnv.YOUTUBE_API_KEY;
  if (JSON.stringify(merged) !== JSON.stringify(vars)) {
    writeVars(DEV_VARS, merged, 'Local dashboard settings (git-ignored). Written by `npm start`; edit freely.');
  }
  return merged;
}

async function start() {
  needInstall();
  const vars = localVars();
  console.log('Preparing the local database…');
  wrangler(['d1', 'execute', 'visto-db', '--local', '--persist-to', PERSIST, '--file', join(ROOT, 'worker', 'schema.sql')], { capture: true });
  printConnect(LOCAL_URL, vars.INGEST_TOKEN);
  if (!vars.YOUTUBE_API_KEY) {
    console.log('  Tip: add YOUTUBE_API_KEY to worker/.dev.vars for durations, topics and channel avatars (see README).\n');
  }
  const dev = spawn(process.execPath, [WRANGLER, 'dev', '--config', TEMPLATE, '--port', String(PORT), '--persist-to', PERSIST],
    { cwd: ROOT, stdio: 'inherit' });
  // wrangler dev does not run crons: trigger the enrichment ourselves.
  const tick = () => fetch(`${LOCAL_URL}/cdn-cgi/local/scheduled`).catch(() => {});
  const first = setTimeout(tick, 20_000);
  const every = setInterval(tick, ENRICH_EVERY_MS);
  dev.on('exit', code => { clearTimeout(first); clearInterval(every); process.exit(code ?? 0); });
}

// ---------- cloud ---------------------------------------------------------------

function stripJsonc(text) {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
}

async function cloud() {
  needInstall();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def;

  try {
    if (!/You are logged in/i.test(wrangler(['whoami'], { capture: true }))) {
      console.log('Log in to Cloudflare (a browser window opens)…');
      wrangler(['login']);
    }
  } catch {
    wrangler(['login']);
  }

  if (!existsSync(CLOUD)) {
    console.log('\nNew Cloudflare deployment. It runs on the free plan (Workers + D1).');
    const name = await ask('Worker name (becomes <name>.<your-subdomain>.workers.dev)', 'visto');
    const tz = await ask('Time zone for days and hours', systemTz());
    const pub = (await ask('Make the dashboard public, read-only, without a password? (y/N)', 'N')).toLowerCase().startsWith('y');
    const dbName = `${name}-db`;
    console.log(`Creating the D1 database ${dbName}…`);
    const out = wrangler(['d1', 'create', dbName], { capture: true });
    const id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(out)?.[1];
    if (!id) throw new Error(`could not read the new database id from wrangler:\n${out}`);
    const cfg = readFileSync(TEMPLATE, 'utf8')
      .replace(/"name": "visto"/, `"name": ${JSON.stringify(name)}`)
      .replace(/"database_name": "visto-db"/, `"database_name": ${JSON.stringify(dbName)}`)
      .replace(/"database_id": "[^"]*"/, `"database_id": "${id}"`)
      .replace(/"TZ": "[^"]*"/, `"TZ": ${JSON.stringify(tz)}`)
      .replace(/"PUBLIC_DASHBOARD": "[^"]*"/, `"PUBLIC_DASHBOARD": "${pub ? '1' : '0'}"`);
    writeFileSync(CLOUD, cfg);
    console.log('Wrote worker/wrangler.local.jsonc');
  }
  rl.close();

  const cfg = JSON.parse(stripJsonc(readFileSync(CLOUD, 'utf8')));
  const db = cfg.d1_databases[0].database_name;
  console.log('Applying the database schema…');
  wrangler(['d1', 'execute', db, '--remote', '--yes', '--file', join(ROOT, 'worker', 'schema.sql')], { config: CLOUD, capture: true });

  console.log('Deploying the Worker…');
  const dep = wrangler(['deploy'], { config: CLOUD, capture: true });
  process.stdout.write(dep);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(dep)?.[0] || readVars(ENV).VISTO_URL;

  const env = readVars(ENV);
  const secrets = {
    INGEST_TOKEN: env.INGEST_TOKEN || readVars(DEV_VARS).INGEST_TOKEN || token(),
    SESSION_SECRET: env.SESSION_SECRET || token(32),
    DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD || token(9),
  };
  const fresh = Object.keys(secrets).filter(k => !env[k]);
  for (const k of fresh) {
    console.log(`Setting the ${k} secret…`);
    wrangler(['secret', 'put', k], { config: CLOUD, input: secrets[k] });
  }
  writeVars(ENV, { ...env, ...secrets, VISTO_URL: url }, 'Cloud deployment secrets (git-ignored). Written by `npm run cloud`.');

  console.log(`\nDone. Password for the dashboard: ${secrets.DASHBOARD_PASSWORD} (kept in .env)`);
  if (url) printConnect(url, secrets.INGEST_TOKEN);
  console.log('  Optional: `npm run wrangler -- secret put YOUTUBE_API_KEY` for durations, topics and avatars.');
  console.log('  Bringing local data up (Takeout, a local full import): python ingest/push_prod.py --apply\n');
}

// ---------- entry ---------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'start') await start();
  else if (cmd === 'cloud') await cloud();
  else if (cmd === 'connect') {
    if (rest[0] === 'cloud') {
      const env = readVars(ENV);
      if (!env.VISTO_URL || !env.INGEST_TOKEN) throw new Error('no cloud deployment yet: run `npm run cloud`');
      printConnect(env.VISTO_URL, env.INGEST_TOKEN);
    } else printConnect(LOCAL_URL, localVars().INGEST_TOKEN);
  } else if (cmd === 'wrangler') {
    needInstall();
    wrangler(rest, { config: existsSync(CLOUD) ? CLOUD : TEMPLATE });
  } else {
    console.log('usage: node scripts/visto.mjs start | connect [cloud] | cloud | wrangler <args…>');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
