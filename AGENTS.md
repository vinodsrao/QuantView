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
   UI Timeframe buttons (1D, 1W, 1M) represent candle bar periods (intervals), NOT ranges:
   - `1d` -> Daily bars (`interval=1d`, `range=10y`)
   - `1w` -> Weekly bars (`interval=1wk`, `range=10y`)
   - `1M` -> Monthly bars (`interval=1mo`, `range=max`)
2. **Timestamps:** Yahoo Finance returns Unix timestamps in seconds (`result.timestamp[]`).
3. **Chart Rendering:** All charts use `LightweightCharts` with synchronized price and volume panes.
4. **Deployments:** Never use `amondnet/vercel-action` or old Wrangler actions; use `vercel@latest` and `npx wrangler` directly in GHA.