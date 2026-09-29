// FlowBatch usage stats — a Cloudflare Worker (free plan) with a D1 database.
//
//   POST /e      the extension's batched events: { uid, v, events: [{ e, d?, n? }] }
//   GET  /stats  totals for the website — aggregates only, cached for 10 minutes
//
// Stored: a random install ID, feature counts per day, the extension version, and the two-letter
// country Cloudflare attaches to the request (request.cf.country). Never stored: IP addresses,
// prompts, file names, URLs or anything the user typed.

const EVENTS = new Set([
  'session', // side panel opened (or used again after 30 idle minutes)
  'run', // queue started — detail: flow | gemini, n: prompts
  'result', // results made — detail: flow-video | flow-image | gemini-video | gemini-image
  'failed', // prompts that failed — detail: site
  'frames', // frames extracted — detail: video | url | tab
  'split', // video split into clips
  'clips-save',
  'clips-send', // clips sent to a site — detail: flow | gemini
  'zip',
  'publish', // publish plan exported
  'sparkle', // Gemini sparkle removed — detail: image | video
  'per-asset', // "One prompt per asset"
  'per-pair', // "One prompt per frame pair"
  'seq-frames', // run using start → end frame pairs
  'gemini-share', // "Send to FlowBatch" from Gemini's Share dialog
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DETAIL = /^[a-z0-9-]{0,24}$/;
const VERSION = /^[0-9.]{1,16}$/;
const MAX_BODY = 16 * 1024;
const MAX_EVENTS = 50;
const DAILY_CAP = 3000; // events per install per day; more are dropped (a runaway or a spammer)
const CACHE_SECONDS = 600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/e' && request.method === 'POST') return ingest(request, env);
    if (pathname === '/stats' && request.method === 'GET') return stats(request, env, ctx);
    return json({ error: 'not found' }, 404);
  },
};

/** Validate a batch and add it to the day's totals. */
async function ingest(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const uid = String(body?.uid || '');
  if (!UUID.test(uid)) return json({ error: 'bad uid' }, 400);
  const version = VERSION.test(String(body?.v || '')) ? String(body.v) : '';
  const list = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : [];

  // Merge the batch into { "event|detail": n }, keeping only known events.
  const merged = new Map();
  let total = 0;
  for (const ev of list) {
    const e = String(ev?.e || '');
    const d = String(ev?.d ?? '');
    const n = Math.floor(Number(ev?.n ?? 1));
    if (!EVENTS.has(e) || !DETAIL.test(d) || !(n >= 1 && n <= 500)) continue;
    const key = `${e}|${d}`;
    merged.set(key, (merged.get(key) || 0) + n);
    total += n;
  }
  if (!merged.size) return json({ error: 'no known events' }, 400);

  const country = /^[A-Z0-9]{2}$/.test(request.cf?.country || '') ? request.cf.country : 'XX';
  const day = today();
  const now = new Date().toISOString();

  const seen = await env.DB.prepare('SELECT events FROM active WHERE day = ? AND uid = ?').bind(day, uid).first();
  if ((seen?.events || 0) + total > DAILY_CAP) return new Response(null, { status: 204, headers: CORS });

  const statements = [
    env.DB.prepare(
      `INSERT INTO users (uid, first_seen, last_seen, country, version) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET last_seen = excluded.last_seen, country = excluded.country, version = excluded.version`
    ).bind(uid, now, now, country, version),
    env.DB.prepare(
      `INSERT INTO active (day, uid, events) VALUES (?, ?, ?)
       ON CONFLICT (day, uid) DO UPDATE SET events = events + excluded.events`
    ).bind(day, uid, total),
  ];
  for (const [key, n] of merged) {
    const [e, d] = key.split('|');
    statements.push(
      env.DB.prepare(
        `INSERT INTO counts (day, event, detail, n) VALUES (?, ?, ?, ?)
         ON CONFLICT (day, event, detail) DO UPDATE SET n = n + excluded.n`
      ).bind(day, e, d, n)
    );
  }
  await env.DB.batch(statements);
  return new Response(null, { status: 204, headers: CORS });
}

/** Totals for the website, computed in one batch and cached. */
async function stats(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL('/stats', request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const d0 = today();
  const d7 = daysAgo(6);
  const d30 = daysAgo(29);
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const [installs, a1, a7, a30, sessions, results, runs, featuresAll, features30, countries, daily] = await env.DB.batch([
    q('SELECT COUNT(*) AS n FROM users'),
    q('SELECT COUNT(DISTINCT uid) AS n FROM active WHERE day >= ?', d0),
    q('SELECT COUNT(DISTINCT uid) AS n FROM active WHERE day >= ?', d7),
    q('SELECT COUNT(DISTINCT uid) AS n FROM active WHERE day >= ?', d30),
    q("SELECT COALESCE(SUM(n), 0) AS n FROM counts WHERE event = 'session'"),
    q("SELECT detail, SUM(n) AS n FROM counts WHERE event = 'result' GROUP BY detail"),
    q("SELECT detail, SUM(n) AS n FROM counts WHERE event = 'run' GROUP BY detail"),
    q("SELECT event, SUM(n) AS n FROM counts WHERE event NOT IN ('session', 'result', 'failed') GROUP BY event ORDER BY n DESC"),
    q("SELECT event, SUM(n) AS n FROM counts WHERE event NOT IN ('session', 'result', 'failed') AND day >= ? GROUP BY event ORDER BY n DESC", d30),
    q('SELECT country, COUNT(*) AS n FROM users GROUP BY country ORDER BY n DESC LIMIT 20'),
    q('SELECT day, COUNT(*) AS n FROM active WHERE day >= ? GROUP BY day ORDER BY day', d30),
  ]);

  const one = (r) => r.results?.[0]?.n ?? 0;
  const made = { video: 0, image: 0, bySite: {} };
  for (const { detail, n } of results.results || []) {
    const [site, kind] = String(detail).split('-');
    if (kind === 'video' || kind === 'image') made[kind] += n;
    made.bySite[site] = made.bySite[site] || { video: 0, image: 0 };
    if (kind === 'video' || kind === 'image') made.bySite[site][kind] += n;
  }
  const body = {
    updatedAt: new Date().toISOString(),
    installs: one(installs),
    active: { today: one(a1), days7: one(a7), days30: one(a30) },
    sessions: one(sessions),
    made,
    prompts: Object.fromEntries((runs.results || []).map((r) => [r.detail || 'unknown', r.n])),
    features: { allTime: featuresAll.results, days30: features30.results },
    countries: countries.results,
    dailyActive: daily.results,
  };
  const response = json(body, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
