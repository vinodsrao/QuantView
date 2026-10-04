const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEFAULT_SEED = {
  "Tech & Crypto": [
    { type: "section", title: "### STOCKS" },
    { type: "ticker", symbol: "AAPL" },
    { type: "ticker", symbol: "PH" },
    { type: "ticker", symbol: "AXISCADES.NS" },
    { type: "ticker", symbol: "TVSMOTOR.NS" },
    { type: "ticker", symbol: "TSLA" },
    { type: "ticker", symbol: "NVDA" },
    { type: "section", title: "### CRYPTO" },
    { type: "ticker", symbol: "BTC-USD" },
    { type: "ticker", symbol: "ETH-USD" },
  ],
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function requireDB(env) {
  if (!env || !env.DB) {
    throw new Error(
      "D1 database binding `DB` is not configured. Create it (`wrangler d1 create quantview-db`), set database_id in worker/wrangler.toml, and apply migrations."
    );
  }
  return env.DB;
}

async function ensureSeeded(db) {
  const countRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists").first();
  if (countRow && countRow.n > 0) return;
  let wlPos = 0;
  for (const [name, items] of Object.entries(DEFAULT_SEED)) {
    const wl = await db
      .prepare("INSERT INTO watchlists (name, position) VALUES (?, ?)")
      .bind(name, wlPos++)
      .run();
    const watchlistId = wl.meta.last_row_id;
    let itemPos = 0;
    for (const item of items) {
      await db
        .prepare(
          "INSERT INTO watchlist_items (watchlist_id, item_type, symbol, title, position) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(
          watchlistId,
          item.type,
          item.type === "ticker" ? item.symbol : null,
          item.type === "section" ? item.title : null,
          itemPos++
        )
        .run();
    }
  }
}

async function listWatchlists(db) {
  await ensureSeeded(db);
  const { results: wls } = await db
    .prepare("SELECT id, name FROM watchlists ORDER BY position ASC, id ASC")
    .all();
  const { results: items } = await db
    .prepare(
      "SELECT id, watchlist_id, item_type, symbol, title, position FROM watchlist_items ORDER BY watchlist_id ASC, position ASC, id ASC"
    )
    .all();
  const byWl = new Map();
  for (const w of wls || []) byWl.set(w.id, []);
  for (const it of items || []) {
    if (!byWl.has(it.watchlist_id)) continue;
    byWl.get(it.watchlist_id).push({
      id: it.id,
      type: it.item_type,
      symbol: it.symbol,
      title: it.title,
    });
  }
  return (wls || []).map((w) => ({
    id: w.id,
    name: w.name,
    items: byWl.get(w.id) || [],
  }));
}

async function handleWatchlistsAPI(request, env) {
  const db = requireDB(env);
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  // Strip "/api" prefix, e.g. "/api/watchlists/3/items" -> "/watchlists/3/items"
  const path = url.pathname.replace(/^\/api/, "") || "/";

  const readJson = async () => {
    try {
      return await request.json();
    } catch {
      return {};
    }
  };

  // GET /api/watchlists
  if (path === "/watchlists" && method === "GET") {
    const data = await listWatchlists(db);
    return json(data);
  }

  // POST /api/watchlists { name }
  if (path === "/watchlists" && method === "POST") {
    const { name } = await readJson();
    const clean = (name || "").trim();
    if (!clean) return json({ error: "name is required" }, 400);
    const maxRow = await db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM watchlists").first();
    const pos = (maxRow?.m ?? -1) + 1;
    try {
      const res = await db.prepare("INSERT INTO watchlists (name, position) VALUES (?, ?)").bind(clean, pos).run();
      return json({ id: res.meta.last_row_id, name: clean, items: [] }, 201);
    } catch (e) {
      if (String(e?.message || "").includes("UNIQUE")) return json({ error: "A watchlist with that name already exists" }, 409);
      throw e;
    }
  }

  // /api/watchlists/:id
  let m = path.match(/^\/watchlists\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") {
      const wl = await db.prepare("SELECT id, name FROM watchlists WHERE id = ?").bind(id).first();
      if (!wl) return json({ error: "not found" }, 404);
      const { results } = await db
        .prepare("SELECT id, item_type, symbol, title FROM watchlist_items WHERE watchlist_id = ? ORDER BY position ASC, id ASC")
        .bind(id)
        .all();
      return json({
        id: wl.id,
        name: wl.name,
        items: (results || []).map((r) => ({ id: r.id, type: r.item_type, symbol: r.symbol, title: r.title })),
      });
    }
    if (method === "PUT" || method === "PATCH") {
      const { name } = await readJson();
      const clean = (name || "").trim();
      if (!clean) return json({ error: "name is required" }, 400);
      try {
        const res = await db.prepare("UPDATE watchlists SET name = ? WHERE id = ?").bind(clean, id).run();
        if (res.meta.changes === 0) return json({ error: "not found" }, 404);
        return json({ id, name: clean });
      } catch (e) {
        if (String(e?.message || "").includes("UNIQUE")) return json({ error: "A watchlist with that name already exists" }, 409);
        throw e;
      }
    }
    if (method === "DELETE") {
      const { results } = await db.prepare("SELECT COUNT(*) AS n FROM watchlists").all();
      // Fallback count check
      const countRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists").first();
      if (countRow && countRow.n <= 1) {
        return json({ error: "You must keep at least one watchlist." }, 400);
      }
      void results;
      const res = await db.prepare("DELETE FROM watchlists WHERE id = ?").bind(id).run();
      if (res.meta.changes === 0) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
  }

  // POST /api/watchlists/:id/items { type, symbol?, title? }
  m = path.match(/^\/watchlists\/(\d+)\/items$/);
  if (m && method === "POST") {
    const watchlistId = Number(m[1]);
    const wl = await db.prepare("SELECT id FROM watchlists WHERE id = ?").bind(watchlistId).first();
    if (!wl) return json({ error: "watchlist not found" }, 404);
    const body = await readJson();
    const type = body.type;
    if (type !== "section" && type !== "ticker") return json({ error: "type must be 'section' or 'ticker'" }, 400);
    let symbol = null;
    let title = null;
    if (type === "ticker") {
      symbol = (body.symbol || "").toUpperCase().trim();
      if (!symbol) return json({ error: "symbol is required" }, 400);
    } else {
      title = (body.title || "").trim().toUpperCase() || "### NEW SECTION";
    }
    const maxRow = await db
      .prepare("SELECT COALESCE(MAX(position), -1) AS m FROM watchlist_items WHERE watchlist_id = ?")
      .bind(watchlistId)
      .first();
    const pos = (maxRow?.m ?? -1) + 1;
    const res = await db
      .prepare("INSERT INTO watchlist_items (watchlist_id, item_type, symbol, title, position) VALUES (?, ?, ?, ?, ?)")
      .bind(watchlistId, type, symbol, title, pos)
      .run();
    return json({ id: res.meta.last_row_id, type, symbol, title }, 201);
  }

  // PUT /api/watchlists/:id/items/order { orderedIds: number[] } — persist drag-drop
  m = path.match(/^\/watchlists\/(\d+)\/items\/order$/);
  if (m && (method === "PUT" || method === "PATCH")) {
    const watchlistId = Number(m[1]);
    const wl = await db.prepare("SELECT id FROM watchlists WHERE id = ?").bind(watchlistId).first();
    if (!wl) return json({ error: "watchlist not found" }, 404);
    const { orderedIds } = await readJson();
    if (!Array.isArray(orderedIds)) return json({ error: "orderedIds[] is required" }, 400);
    const stmts = orderedIds.map((itemId, idx) =>
      db.prepare("UPDATE watchlist_items SET position = ? WHERE id = ? AND watchlist_id = ?").bind(idx, Number(itemId), watchlistId)
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  // DELETE /api/watchlists/:id/items/:itemId
  m = path.match(/^\/watchlists\/(\d+)\/items\/(\d+)$/);
  if (m && method === "DELETE") {
    const watchlistId = Number(m[1]);
    const itemId = Number(m[2]);
    const res = await db
      .prepare("DELETE FROM watchlist_items WHERE id = ? AND watchlist_id = ?")
      .bind(itemId, watchlistId)
      .run();
    if (res.meta.changes === 0) return json({ error: "not found" }, 404);
    return json({ ok: true });
  }

  return json({ error: "unknown API route" }, 404);
}

async function handleYahooProxy(request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "AAPL";
  const range = url.searchParams.get("range") || "10y";
  const interval = url.searchParams.get("interval") || "1d";

  const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;

  try {
    const apiRes = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const data = await apiRes.text();

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleWatchlistsAPI(request, env);
      } catch (err) {
        console.error("Watchlist API error:", err);
        const isConfig = String(err?.message || "").includes("D1 database binding");
        return json({ error: err.message }, isConfig ? 500 : 500);
      }
    }

    return handleYahooProxy(request);
  },
};
