-- Rebuild watchlists to drop the global UNIQUE(name) constraint:
-- watchlist names must now only be unique per user.
-- watchlist_items is rebuilt too so its foreign key survives the parent rebuild
-- (SQLite cascades child rows on DROP TABLE when FKs are enabled).

CREATE TABLE watchlists_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id)
);

INSERT INTO watchlists_new (id, name, position, created_at, user_id)
  SELECT id, name, position, created_at, user_id FROM watchlists;

CREATE TABLE watchlist_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('section', 'ticker')),
  symbol TEXT,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

INSERT INTO watchlist_items_new (id, watchlist_id, item_type, symbol, title, position)
  SELECT id, watchlist_id, item_type, symbol, title, position FROM watchlist_items;

DROP TABLE watchlist_items;
DROP TABLE watchlists;

ALTER TABLE watchlists_new RENAME TO watchlists;
ALTER TABLE watchlist_items_new RENAME TO watchlist_items;

CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist_id ON watchlist_items(watchlist_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_items_position ON watchlist_items(watchlist_id, position);
CREATE INDEX IF NOT EXISTS idx_watchlists_position ON watchlists(position);
CREATE INDEX IF NOT EXISTS idx_watchlists_user_id ON watchlists(user_id);

-- Duplicate names are still rejected, but only within the same user's account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_id_name ON watchlists(user_id, name);
