# QuantView Project Rules & Architecture

## Architecture Overview
- **Frontend (`index.html`):** Static HTML + Tailwind CSS + Lightweight Charts. Deployed via Cloudflare Pages (`quantview`) and Vercel (fallback).
- **Backend (`worker/`):** Cloudflare Worker (`stock-proxy`) acting as a CORS proxy for Yahoo Finance data (`https://query1.finance.yahoo.com/v8/finance/chart/`).
- **CI/CD (`.github/workflows/deploy.yml`):** Automatically deploys:
  1. Worker via Wrangler (`worker/`)
  2. Frontend via `npx wrangler pages deploy . --project-name=quantview`
  3. Fallback Frontend via `vercel@latest`

## Key Constraints & Conventions
1. **Yahoo Finance Ranges & Intervals:**
   - `1d` -> `range=1d&interval=5m`
   - `1w` -> `range=5d&interval=15m`
   - `1M` -> `range=1mo&interval=1d`
2. **Timestamps:** Yahoo Finance returns Unix timestamps in seconds (`result.timestamp[]`).
3. **Chart Rendering:** All charts use `LightweightCharts` with synchronized price and volume panes.
4. **Deployments:** Never use `amondnet/vercel-action` or old Wrangler actions; use `vercel@latest` and `npx wrangler` directly in GHA.