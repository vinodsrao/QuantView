import { handleAutoRefresh, handleScannerRefresh } from './tv_scanner.js';
import { handleNseFnoRefresh, handleNseFnoSymbols } from './nse_fno.js';

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

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

async function pbkdf2Hash(password, saltB64, iterations = 100000) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return base64Encode(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  let allowed = [];
  if (env && env.ALLOWED_ORIGINS) {
    allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    allowed = [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
    ];
  }
  // Built-in suffix allowlist for deployed frontends.
  const suffixes = [".pages.dev", ".vercel.app"];
  if (allowed.includes(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return origin;
    if (suffixes.some((s) => u.hostname.endsWith(s))) return origin;
  } catch {}
  if (allowed.some((a) => origin === a)) return origin;
  return null;
}

function applyCors(response, request, env) {
  const headers = new Headers(response.headers);
  // Remove any wildcard set by handlers; replace with exact allowed origin.
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  const origin = getAllowedOrigin(request, env);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Bootstrap-Token");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireDB(env) {
  if (!env || !env.DB) {
    throw new Error(
      "D1 database binding `DB` is not configured. Create it (`wrangler d1 create quantview-db`), set database_id in worker/wrangler.toml, and apply migrations."
    );
  }
  return env.DB;
}

async function ensureSeeded(db, userId) {
  // Claim any pre-auth (legacy) watchlists for the first user who signs in.
  const orphanRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id IS NULL").first();
  const userRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ?").bind(userId).first();
  if (orphanRow && orphanRow.n > 0 && (!userRow || userRow.n === 0)) {
    await db.prepare("UPDATE watchlists SET user_id = ? WHERE user_id IS NULL").bind(userId).run();
  }
  const countRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ?").bind(userId).first();
  if (countRow && countRow.n > 0) return;
  let wlPos = 0;
  for (const [name, items] of Object.entries(DEFAULT_SEED)) {
    const wl = await db
      .prepare("INSERT INTO watchlists (name, position, user_id) VALUES (?, ?, ?)")
      .bind(name, wlPos++, userId)
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

async function listWatchlists(db, userId) {
  await ensureSeeded(db, userId);
  const { results: wls } = await db
    .prepare("SELECT id, name FROM watchlists WHERE user_id = ? ORDER BY position ASC, id ASC")
    .bind(userId)
    .all();
  const wlIds = (wls || []).map((w) => w.id);
  let items = [];
  if (wlIds.length) {
    const placeholders = wlIds.map(() => "?").join(",");
    const q = await db
      .prepare(
        `SELECT id, watchlist_id, item_type, symbol, title, position FROM watchlist_items WHERE watchlist_id IN (${placeholders}) ORDER BY watchlist_id ASC, position ASC, id ASC`
      )
      .bind(...wlIds)
      .all();
    items = q.results || [];
  }
  const byWl = new Map();
  for (const w of wls || []) byWl.set(w.id, []);
  for (const it of items) {
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

async function handleWatchlistsAPI(request, env, user) {
  const db = requireDB(env);
  const userId = user.id;
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
    const data = await listWatchlists(db, userId);
    return json(data);
  }

  // POST /api/watchlists { name }
  if (path === "/watchlists" && method === "POST") {
    const { name } = await readJson();
    const clean = (name || "").trim();
    if (!clean) return json({ error: "name is required" }, 400);
    const maxRow = await db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM watchlists WHERE user_id = ?").bind(userId).first();
    const pos = (maxRow?.m ?? -1) + 1;
    try {
      const res = await db.prepare("INSERT INTO watchlists (name, position, user_id) VALUES (?, ?, ?)").bind(clean, pos, userId).run();
      return json({ id: res.meta.last_row_id, name: clean, items: [] }, 201);
    } catch (e) {
      if (String(e?.message || "").includes("UNIQUE")) return json({ error: "A watchlist with that name already exists" }, 409);
      throw e;
    }
  }

  // PUT /api/watchlists/order { orderedIds: number[] } — persist watchlist reorder
  if (path === "/watchlists/order" && (method === "PUT" || method === "PATCH")) {
    const { orderedIds } = await readJson();
    if (!Array.isArray(orderedIds)) return json({ error: "orderedIds[] is required" }, 400);
    const stmts = orderedIds.map((wlId, idx) =>
      db.prepare("UPDATE watchlists SET position = ? WHERE id = ? AND user_id = ?").bind(idx, Number(wlId), userId)
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  // /api/watchlists/:id
  let m = path.match(/^\/watchlists\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") {
      const wl = await db.prepare("SELECT id, name FROM watchlists WHERE id = ? AND user_id = ?").bind(id, userId).first();
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
         const res = await db.prepare("UPDATE watchlists SET name = ? WHERE id = ? AND user_id = ?").bind(clean, id, userId).run();
        if (res.meta.changes === 0) return json({ error: "not found" }, 404);
        return json({ id, name: clean });
      } catch (e) {
        if (String(e?.message || "").includes("UNIQUE")) return json({ error: "A watchlist with that name already exists" }, 409);
        throw e;
      }
    }
    if (method === "DELETE") {
      const countRow = await db.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ?").bind(userId).first();
      if (countRow && countRow.n <= 1) {
        return json({ error: "You must keep at least one watchlist." }, 400);
      }
      const res = await db.prepare("DELETE FROM watchlists WHERE id = ? AND user_id = ?").bind(id, userId).run();
      if (res.meta.changes === 0) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
  }

  // POST /api/watchlists/:id/items { type, symbol?, title? }
  m = path.match(/^\/watchlists\/(\d+)\/items$/);
  if (m && method === "POST") {
    const watchlistId = Number(m[1]);
    const wl = await db.prepare("SELECT id FROM watchlists WHERE id = ? AND user_id = ?").bind(watchlistId, userId).first();
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
    const wl = await db.prepare("SELECT id FROM watchlists WHERE id = ? AND user_id = ?").bind(watchlistId, userId).first();
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
    const wl = await db.prepare("SELECT id FROM watchlists WHERE id = ? AND user_id = ?").bind(watchlistId, userId).first();
    if (!wl) return json({ error: "watchlist not found" }, 404);
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

async function handleSearch(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q is required" }, 400);

  const targetUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}`;

  try {
    const apiRes = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!apiRes.ok) {
      return json({ error: `Yahoo search error: ${apiRes.status}` }, 502);
    }
    const data = await apiRes.json();
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    const results = quotes
      .filter((item) => item.symbol)
      .map((item) => ({
        symbol: item.symbol,
        shortName: item.shortname || item.longname || "",
        exchange: item.exchange || "",
        type: item.quoteType || item.typeDisp || "",
      }))
      .slice(0, 15);

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
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

async function authenticate(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const pepper = env && env.SESSION_PEPPER;
  if (!pepper) throw new Error("SESSION_PEPPER is not configured");
  const tokenHash = await sha256Hex(token + pepper);
  const db = requireDB(env);
  const row = await db
    .prepare("SELECT s.user_id AS id, s.expires_at, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

async function handleAuth(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method.toUpperCase();
  const db = requireDB(env);
  const pepper = env && env.SESSION_PEPPER;
  if (!pepper) throw new Error("SESSION_PEPPER is not configured");

  // POST /api/auth/register
  if (path === "/auth/register" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch {}
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "valid email required" }, 400);
    if (password.length < 8) return json({ error: "password must be at least 8 chars" }, 400);

    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
    const userCount = (countRow && countRow.n) || 0;
    if (userCount > 0) {
      const bt = request.headers.get("X-Bootstrap-Token");
      if (!env.BOOTSTRAP_TOKEN || bt !== env.BOOTSTRAP_TOKEN) return json({ error: "forbidden" }, 403);
    }

    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return json({ error: "email already registered" }, 409);

    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = base64Encode(saltBytes);
    const hash = await pbkdf2Hash(password, salt);
    const role = userCount === 0 ? "admin" : "user";
    const res = await db
      .prepare("INSERT INTO users (email, password_hash, password_salt, role) VALUES (?, ?, ?, ?)")
      .bind(email, hash, salt, role)
      .run();
    const userId = res.meta.last_row_id;

    const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token + pepper);
    const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, expires).run();

    return new Response(JSON.stringify({ id: userId, email, role, token }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  // POST /api/auth/login
  if (path === "/auth/login" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch {}
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = await db.prepare("SELECT id, email, password_hash, password_salt, role FROM users WHERE email = ?").bind(email).first();
    if (!user) return json({ error: "invalid credentials" }, 401);
    const hash = await pbkdf2Hash(password, user.password_salt);
    if (!constantTimeEqual(hash, user.password_hash)) return json({ error: "invalid credentials" }, 401);

    const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token + pepper);
    const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, user.id, expires).run();

    return new Response(JSON.stringify({ id: user.id, email: user.email, role: user.role, token }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  // POST /api/auth/logout
  if (path === "/auth/logout" && method === "POST") {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;
    if (token) {
      const tokenHash = await sha256Hex(token + pepper);
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  // GET /api/auth/me
  if (path === "/auth/me" && method === "GET") {
    const u = await authenticate(request, env);
    if (!u) return json({ error: "unauthorized" }, 401);
    return json({ id: u.id, email: u.email, role: u.role });
  }

  return json({ error: "unknown auth route" }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return applyCors(new Response(null, { status: 204 }), request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    const isAuthRoute = path.startsWith("/api/auth/");
    let user = null;
    if (!isAuthRoute) {
      user = await authenticate(request, env);
      if (!user) {
        return applyCors(json({ error: "unauthorized" }, 401), request, env);
      }
    }

    // Auth API routes
    if (isAuthRoute) {
      const res = await handleAuth(request, env);
      return applyCors(res, request, env);
    }

    // Search API route
    if (path === "/api/search" && method === "GET") {
      return applyCors(await handleSearch(request), request, env);
    }

    // Scanner API routes
    if (path === "/api/scanner/auto-refresh" && method === "GET") {
      return applyCors(await handleAutoRefresh(request, env, user), request, env);
    }
    if (path === "/api/scanner/refresh" && method === "POST") {
      return applyCors(await handleScannerRefresh(request, env, user), request, env);
    }
    if (path === "/api/scanner/nse-fno/refresh" && method === "POST") {
      return applyCors(await handleNseFnoRefresh(request, env, user), request, env);
    }
    if (path === "/api/nse/fno-symbols" && method === "GET") {
      return applyCors(await handleNseFnoSymbols(request), request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return applyCors(await handleWatchlistsAPI(request, env, user), request, env);
      } catch (err) {
        console.error("Watchlist API error:", err);
        const isConfig = String(err?.message || "").includes("D1 database binding");
        return applyCors(json({ error: err.message }, isConfig ? 500 : 500), request, env);
      }
    }

    return applyCors(await handleYahooProxy(request), request, env);
  },
};
