# FlowBatch stats endpoint

A Cloudflare Worker with a D1 (SQLite) database, both on the free plan: no card, 100,000 requests a day,
5 GB of storage. The extension batches its counts, so this covers thousands of daily users.

- `POST /e`: the extension's batched, anonymous counts (validated against a fixed list of events)
- `GET /stats`: totals only, for the website (cached for 10 minutes)

What's stored and what isn't: see "Usage stats and privacy" in the main README. No IP addresses are
stored; the country comes from Cloudflare's `request.cf.country`.

Live at <https://flowbatch-stats.flowbatch-stats.workers.dev> (totals: `/stats`).

## Deploy (once)

Run in this folder (`analytics/`). If your npm registry is set to plain `http`, add
`--registry https://registry.npmjs.org` to the `npm` command.

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up> (email only).
2. `npm install`
3. `npx wrangler login`: a browser window opens; approve it.
4. `npx wrangler d1 create flowbatch-stats`: copy the `database_id` it prints into `wrangler.toml`.
5. `npm run db:remote`: creates the tables.
6. `npm run deploy`: prints the address, e.g. `https://flowbatch-stats.<you>.workers.dev`.
7. Put that address in `STATS_URL` in `../sidepanel/js/telemetry.js` and in `../docs/index.html`, then
   commit and push.

## Try it locally

```
npm run db:local
npm run dev          # http://127.0.0.1:8787
curl -X POST http://127.0.0.1:8787/e -H "Content-Type: application/json" \
  -d '{"uid":"8b0e8f3a-2c4d-4e5f-9a1b-2c3d4e5f6a7b","v":"1.1.0","events":[{"e":"session"},{"e":"result","d":"gemini-video","n":2}]}'
curl http://127.0.0.1:8787/stats
```

## Reading the raw data

`npx wrangler d1 execute flowbatch-stats --remote --command "SELECT country, COUNT(*) FROM users GROUP BY country"`
