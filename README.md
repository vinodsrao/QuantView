# QuantView

Static stock / ETF / crypto charting (Lightweight Charts) + Cloudflare Worker proxy for Yahoo Finance + D1 (serverless SQLite) watchlists.

## Architecture

- Frontend (`index.html`): static HTML + Tailwind + Lightweight Charts. No build step.
- Backend (`worker/index.js`): Cloudflare Worker `stock-proxy`
  - `GET /?symbol=AAPL&range=10y&interval=1d` → Yahoo Finance CORS proxy
  - `GET/POST /api/watchlists`, `GET/PUT/DELETE /api/watchlists/:id`, `POST/DELETE /api/watchlists/:id/items/:itemId`, `PUT /api/watchlists/:id/items/order` → D1 watchlists
- DB (`worker/migrations/0001_init.sql`): tables `watchlists`, `watchlist_items`. First `GET /api/watchlists` auto-seeds “Tech & Crypto”.
- `WORKER_URL` in `index.html` auto-switches: `http://localhost:8787` on `localhost` / `127.0.0.1`, else production Worker.

## Prerequisites

- Node.js 22+ (`node --version`)
- `npx wrangler` (no global install needed)
- Python 3 (`python3 --version`) for static server, or `npx serve`

## First-time D1 setup

`worker/wrangler.toml` already has `database_id`. For a fresh clone:

```bash
cd worker
npx wrangler d1 create quantview-db
# copy database_id into worker/wrangler.toml
npx wrangler d1 migrations apply quantview-db --local
npx wrangler d1 migrations apply quantview-db --remote
```

## Run locally

Terminal 1 — Worker + local D1 (from repo root):

```bash
cd worker
npx wrangler d1 migrations apply quantview-db --local
npx wrangler dev
# -> http://localhost:8787
```

Terminal 2 — Frontend (from repo root):

```bash
python3 -m http.server 8080
# open http://localhost:8080 (not file://)
```

## Test locally

1. API smoke test:

```bash
curl http://localhost:8787/api/watchlists | head -c 500
curl "http://localhost:8787/?symbol=AAPL&range=10y&interval=1d" | head -c 200
```

Both should return JSON. `{"error":"D1 database binding..."}` means `database_id` / migration missing.

2. Inspect local D1:

```bash
cd worker
npx wrangler d1 execute quantview-db --local --command "SELECT * FROM watchlists;"
npx wrangler d1 execute quantview-db --local --command "SELECT * FROM watchlist_items LIMIT 5;"
```

3. JS syntax:

```bash
node --check worker/index.js
python3 -c "import re;html=open('index.html').read();m=re.findall(r'<script>(.*?)</script>',html,re.S);open('/tmp/qv.js','w').write(m[0])" && node --check /tmp/qv.js
```

4. Browser checklist (`http://localhost:8080`, DevTools Network → `/api/watchlists` = 200):
- Watchlist loads (seeded Tech & Crypto on first run)
- Create / rename / delete watchlist
- + Symbol / + Section, × delete
- Drag-drop reorders and persists after reload
- 1D / 1W / 1M / 3M reload candles; +ve CAGR green `#9cf527`, −ve pink `#f5279c`

## Troubleshooting

- `file://` blank charts: serve over `http://localhost`, CDN + `fetch` need http.
- Port in use: `npx wrangler dev --port 8788` (then temporarily set `WORKER_URL` to same port).
- Stale local DB: `rm -rf worker/.wrangler/state` then re-apply `--local` migration.
- Prod data: use `--remote` flag for `d1 execute` / `migrations apply`.
