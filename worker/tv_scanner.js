/**
 * TradingView Scanner Integration for Quantview
 * Add this to your worker/index.js
 */

// TradingView Scanner API Integration
import { json } from './index.js';

const TV_SCANNER_URLS = {
  us: 'https://scanner.tradingview.com/america/scan',
  india: 'https://scanner.tradingview.com/india/scan'
};

// Pre-defined scan queries for low-vol, momentum/performance names
const SCAN_QUERIES = {
  us: {
    market: 'america',
    columns: ['market_cap_basic', 'AvgValue.Traded_90d', 'ATRP', 'ATRP|1M', 'type'],
    filter: [
      {
        left: 'exchange',
        operation: 'in_range',
        right: ['AMEX', 'NASDAQ', 'NYSE', 'CBOE', 'OTC']
      },
      {
        left: 'type',
        operation: 'in_range',
        right: ['stock', 'dr']
      },
      {
        left: 'Perf.5Y',
        operation: 'greater',
        right: 100
      },
      {
        left: 'Perf.3Y',
        operation: 'greater',
        right: 50
      },
      {
        left: 'ATRP',
        operation: 'less',
        right: 4
      },
      {
        left: 'ATRP|1M',
        operation: 'less',
        right: 12
      },
      {
        left: "AvgValue.Traded_90d",
        operation: "greater",
        right: 3000000
      }
    ],
    sort: {
      sortBy: 'AvgValue.Traded_90d',
      sortOrder: 'desc'
    },
    options: { limit: 1000 }
  },

  india: {
    market: 'india',
    columns: ['market_cap_basic', 'AvgValue.Traded_90d', 'ATRP', 'ATRP|1M', 'type'],
    filter: [
      {
        left: 'exchange',
        operation: 'in_range',
        right: ['NSE']
      },
      {
        left: 'type',
        operation: 'in_range',
        right: ['stock']
      },
      {
        left: 'Perf.5Y',
        operation: 'greater',
        right: 100
      },
      {
        left: 'Perf.3Y',
        operation: 'greater',
        right: 50
      },
      {
        left: 'ATRP',
        operation: 'less',
        right: 4
      },
      {
        left: 'ATRP|1M',
        operation: 'less',
        right: 12
      },
      {
        left: "AvgValue.Traded_90d",
        operation: "greater",
        right: 30000000
      }
    ],
    sort: {
      sortBy: 'AvgValue.Traded_90d',
      sortOrder: 'desc'
    },
    options: { limit: 1000 }
  }
};

const WATCHLIST_NAMES = {
  us: 'US Low-Vol Momentum',
  india: 'India Low-Vol Momentum'
};

// Fetch from TradingView Scanner
async function fetchTVScanner(market) {
  const query = SCAN_QUERIES[market];
  const url = TV_SCANNER_URLS[market];
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify(query)
  });
  
  if (!response.ok) {
    const text = await response.text();
    console.error(`TV Scanner ${market} error:`, response.status, text);
    throw new Error(`TV Scanner ${market} failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data || [];
}

// Sync scanner results to watchlist
async function syncTVScannerWatchlist(db, market) {
  const watchlistName = WATCHLIST_NAMES[market];
  
  // 1. Find or create watchlist
  let wl = await db.prepare('SELECT id FROM watchlists WHERE name = ?')
    .bind(WATCHLIST_NAMES[market]).first();
  
  if (!wl) {
    const maxPos = await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM watchlists').first();
    const pos = (maxPos?.m ?? -1) + 1;
    const res = await db.prepare('INSERT INTO watchlists (name, position) VALUES (?, ?)')
      .bind(WATCHLIST_NAMES[market], pos).run();
    wl = { id: res.meta.last_row_id };
  }
  
  const watchlistId = wl.id;
  
  // 2. Fetch fresh scanner data
  console.log(`Fetching ${market} scanner...`);
  const data = await fetchTVScanner(market);
  
  if (!data?.length) {
    console.log(`No data from ${market} scanner`);
    return { watchlistId, count: 0 };
  }
  
  console.log(`Fetched ${data.length} symbols from ${market} scanner`);
  
  // 2. Clear existing items
  await db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ?')
    .bind(watchlistId).run();
  
  // 3. Insert new items
  const items = data.map((item, idx) => {
    // TradingView returns symbol in 's' field or first column of 'd' array
    // Format is typically "EXCHANGE:SYMBOL" (e.g., "NASDAQ:AAPL" or "NSE:RELIANCE")
    const rawSymbol = item.s || (item.d && item.d[0]);
    if (!rawSymbol) return null;
    
    let symbol;
    if (market === 'us') {
      // US: Remove exchange prefix (e.g., "NASDAQ:AAPL" -> "AAPL")
      symbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;
    } else if (market === 'india') {
      // India: Remove exchange prefix and append .NS (e.g., "NSE:RELIANCE" -> "RELIANCE.NS")
      const baseSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;
      symbol = `${baseSymbol}.NS`;
    } else {
      symbol = rawSymbol;
    }
    
    return {
      watchlistId,
      type: 'ticker',
      symbol: symbol,
      position: idx
    };
  }).filter(item => item.symbol);
  
  if (items.length) {
    const stmts = items.map(item => 
      db.prepare('INSERT INTO watchlist_items (watchlist_id, item_type, symbol, position) VALUES (?, ?, ?, ?)')
        .bind(item.watchlistId, 'ticker', item.symbol, item.position)
    );
    await db.batch(stmts);
  }
  
  return { watchlistId, count: items.length };
}

// Refresh both watchlists
async function refreshScannerWatchlists(db) {
  const results = await Promise.all([
    syncTVScannerWatchlist(db, 'us'),
    syncTVScannerWatchlist(db, 'india')
  ]);
  
  return {
    us: results[0],
    india: results[1],
    timestamp: new Date().toISOString()
  };
}

// API Handler for manual refresh
async function handleScannerRefresh(request, env) {
  try {
    const result = await refreshScannerWatchlists(env.DB);
    return json({ 
      ok: true, 
      message: 'Watchlists refreshed from TradingView scanner',
      data: result
    });
  } catch (err) {
    console.error('Scanner refresh failed:', err);
    return json({ error: err.message }, 500);
  }
}

// Auto-refresh on every page load (no KV needed)
async function handleAutoRefresh(request, env) {
  try {
    const result = await refreshScannerWatchlists(env.DB);
    return json({ 
      ok: true, 
      refreshed: true, 
      data: result 
    });
  } catch (err) {
    console.error('Auto-refresh failed:', err);
    return json({ error: err.message }, 500);
  }
}

export { 
  fetchTVScanner, 
  syncTVScannerWatchlist, 
  refreshScannerWatchlists, 
  handleScannerRefresh,
  handleAutoRefresh,
  SCAN_QUERIES,
  TV_SCANNER_URLS
};
