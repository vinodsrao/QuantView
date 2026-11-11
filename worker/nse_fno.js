import { json } from './index.js';

const WATCHLIST_NAME = 'INDIA F&O';

function formatDateDDMMYYYY(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}${mm}${yyyy}`;
}

async function fetchContractText(date) {
  const url = `https://nsearchives.nseindia.com/content/fo/NSE_FO_contract_${formatDateDDMMYYYY(date)}.csv.gz`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Encoding': 'gzip, deflate',
      'Referer': 'https://www.nseindia.com/',
    },
  });
  if (!response.ok) return null;
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export async function fetchNseFnoSymbols() {
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - i);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    let text;
    try {
      text = await fetchContractText(date);
    } catch (err) {
      continue;
    }
    if (!text) continue;

    const symbolSet = new Set();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length < 4) continue;
      const instrument = cols[2].trim();
      const symbol = cols[3].trim();
      if ((instrument === 'OPTSTK' || instrument === 'FUTSTK') && symbol && !symbol.includes('NSETEST')) {
        symbolSet.add(symbol);
      }
    }
    if (symbolSet.size > 0) return [...symbolSet].sort();
  }
  throw new Error('Unable to fetch NSE F&O contract file');
}

async function ensureWatchlist(db, userId) {
  let wl = await db.prepare('SELECT id FROM watchlists WHERE name = ? AND user_id = ?')
    .bind(WATCHLIST_NAME, userId).first();
  if (wl) return wl.id;
  const maxRow = await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM watchlists WHERE user_id = ?')
    .bind(userId).first();
  const pos = (maxRow?.m ?? -1) + 1;
  const res = await db.prepare('INSERT INTO watchlists (name, position, user_id) VALUES (?, ?, ?)')
    .bind(WATCHLIST_NAME, pos, userId).run();
  return res.meta.last_row_id;
}

export async function syncNseFnoWatchlist(db, userId) {
  const symbols = await fetchNseFnoSymbols();
  const watchlistId = await ensureWatchlist(db, userId);
  await db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ?').bind(watchlistId).run();

  const tickers = symbols.map((s) => `${s}.NS`);
  const chunkSize = 100;
  for (let i = 0; i < tickers.length; i += chunkSize) {
    const chunk = tickers.slice(i, i + chunkSize);
    const stmts = chunk.map((sym, idx) =>
      db.prepare('INSERT INTO watchlist_items (watchlist_id, item_type, symbol, position) VALUES (?, ?, ?, ?)')
        .bind(watchlistId, 'ticker', sym, i + idx)
    );
    if (stmts.length) await db.batch(stmts);
  }
  return { watchlistId, count: tickers.length };
}

export async function handleNseFnoRefresh(request, env, user) {
  try {
    const result = await syncNseFnoWatchlist(env.DB, user.id);
    return json({ ok: true, message: 'NSE F&O watchlist refreshed', data: result });
  } catch (err) {
    console.error('NSE F&O refresh failed:', err);
    return json({ error: err.message }, 500);
  }
}

export async function handleNseFnoSymbols(request) {
  try {
    const symbols = await fetchNseFnoSymbols();
    return json(symbols.map((s) => `${s}.NS`));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
