// SQLite schema + connection helper — ported from backend/app/db.py.
// Authoritative table definitions live here (AGENTS.md Data model).

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// cwd-based (not import.meta.url) so the path survives the production bundle:
// both `vite dev` and `node .output/server/index.mjs` run from the repo root.
export const ROOT = process.env.HOMEINDEXR_ROOT || process.cwd()
const DATA_DIR = path.join(ROOT, 'data')

// Resolve the SQLite path at call time, NOT at import.
//
// Resolving lazily means tests can redirect the database via HOMEINDEXR_DB_PATH
// regardless of import order. Binding this at import time once froze the path to
// the real data/app.db when a test module imported this module before setting the
// env var, and a test reset then wiped real user data. Never reintroduce an
// import-time DB_PATH constant.
export function db_path(): string {
  return (
    process.env.HOMEINDEXR_DB_PATH ||
    process.env.HT_DB_PATH ||
    path.join(DATA_DIR, 'app.db')
  )
}

// Schema is ensured once per resolved path per process; keyed by path so tests
// that point HOMEINDEXR_DB_PATH at a fresh temp file still get a fresh schema.
const initialized_paths = new Set<string>()

export function connect(): Database.Database {
  const p = db_path()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const conn = new Database(p)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  if (!initialized_paths.has(p)) {
    ensure_schema(conn)
    initialized_paths.add(p)
  }
  return conn
}

export function with_conn<T>(fn: (conn: Database.Database) => T): T {
  const conn = connect()
  try {
    return fn(conn)
  } finally {
    conn.close()
  }
}

export function init_db(): void {
  with_conn(() => undefined)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_name TEXT,
    input_address TEXT NOT NULL,
    canonical_address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    property_id TEXT,
    listing_id TEXT,
    property_url TEXT,
    listing_state TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'matched',
    matched_address TEXT,
    best_current_estimate INTEGER,
    estimate_source TEXT,
    estimate_low INTEGER,
    estimate_high INTEGER,
    estimate_date TEXT,
    list_price INTEGER,
    sold_price INTEGER,
    last_sold_price INTEGER,
    beds INTEGER,
    baths REAL,
    sqft INTEGER,
    lot_sqft INTEGER,
    year_built INTEGER,
    latitude REAL,
    longitude REAL,
    list_date TEXT,
    days_on_market INTEGER,
    last_price_change_amount INTEGER,
    last_price_change_date TEXT,
    hoa_fee INTEGER,
    property_type TEXT,
    property_sub_type TEXT,
    stories INTEGER,
    garage INTEGER,
    garage_type TEXT,
    pool TEXT,
    cooling TEXT,
    heating TEXT,
    fireplace TEXT,
    is_new_listing INTEGER,
    is_price_reduced INTEGER,
    is_foreclosure INTEGER,
    flood_factor_score INTEGER,
    flood_factor_severity TEXT,
    raw_json TEXT,
    error TEXT,
    last_fetched_at INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(canonical_address)
);

CREATE TABLE IF NOT EXISTS property_schools (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rating INTEGER,
    grades TEXT,
    education_levels TEXT,
    funding_type TEXT,
    distance_in_miles REAL,
    student_count INTEGER,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (property_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_property_schools_property ON property_schools(property_id);

CREATE TABLE IF NOT EXISTS historical_estimates (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    date TEXT NOT NULL,
    estimate INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (property_id, source, date)
);

CREATE INDEX IF NOT EXISTS idx_hist_property ON historical_estimates(property_id, date);

CREATE TABLE IF NOT EXISTS property_events (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    event_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (property_id, date, event_name, price)
);

CREATE INDEX IF NOT EXISTS idx_events_property ON property_events(property_id, date);

CREATE TABLE IF NOT EXISTS observed_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    observed_at INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'refresh',
    listing_state TEXT,
    listing_id TEXT,
    old_price INTEGER,
    new_price INTEGER,
    price INTEGER NOT NULL,
    delta INTEGER,
    pct REAL,
    UNIQUE(property_id, event_name, source, listing_id, old_price, new_price)
);

CREATE INDEX IF NOT EXISTS idx_observed_events_property ON observed_events(property_id, observed_at);

CREATE TABLE IF NOT EXISTS tax_history (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    assessed_year INTEGER,
    tax INTEGER,
    assessment_building INTEGER,
    assessment_land INTEGER,
    assessment_total INTEGER,
    market_building INTEGER,
    market_land INTEGER,
    market_total INTEGER,
    appraisal_building INTEGER,
    appraisal_land INTEGER,
    appraisal_total INTEGER,
    value_building INTEGER,
    value_land INTEGER,
    value_total INTEGER,
    tax_code_area TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (property_id, year)
);

CREATE INDEX IF NOT EXISTS idx_tax_history_property ON tax_history(property_id, year);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS area_listings (
    zip TEXT PRIMARY KEY,
    listings_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS saved_searches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_created ON saved_searches(created_at);
`

const PROPERTY_CURRENT_COLUMNS: Record<string, string> = {
  property_name: 'TEXT',
  matched_address: 'TEXT',
  best_current_estimate: 'INTEGER',
  estimate_source: 'TEXT',
  estimate_low: 'INTEGER',
  estimate_high: 'INTEGER',
  estimate_date: 'TEXT',
  list_price: 'INTEGER',
  sold_price: 'INTEGER',
  last_sold_price: 'INTEGER',
  beds: 'INTEGER',
  baths: 'REAL',
  sqft: 'INTEGER',
  lot_sqft: 'INTEGER',
  year_built: 'INTEGER',
  latitude: 'REAL',
  longitude: 'REAL',
  list_date: 'TEXT',
  days_on_market: 'INTEGER',
  last_price_change_amount: 'INTEGER',
  last_price_change_date: 'TEXT',
  hoa_fee: 'INTEGER',
  property_type: 'TEXT',
  property_sub_type: 'TEXT',
  stories: 'INTEGER',
  garage: 'INTEGER',
  garage_type: 'TEXT',
  pool: 'TEXT',
  cooling: 'TEXT',
  heating: 'TEXT',
  fireplace: 'TEXT',
  is_new_listing: 'INTEGER',
  is_price_reduced: 'INTEGER',
  is_foreclosure: 'INTEGER',
  flood_factor_score: 'INTEGER',
  flood_factor_severity: 'TEXT',
  raw_json: 'TEXT',
  error: 'TEXT',
  last_fetched_at: 'INTEGER',
  pinned: 'INTEGER NOT NULL DEFAULT 0',
}

function table_exists(conn: Database.Database, table: string): boolean {
  return (
    conn
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  )
}

function property_columns(conn: Database.Database): Set<string> {
  const rows = conn.prepare('SELECT name FROM pragma_table_info(?)').all('properties') as any[]
  return new Set(rows.map((r) => r.name))
}

function migrate_properties_current_state(conn: Database.Database): void {
  const existing_cols = property_columns(conn)
  if (!existing_cols.has('pinned') && existing_cols.has('favorited')) {
    conn.exec('ALTER TABLE properties ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    conn.exec('UPDATE properties SET pinned = favorited')
    existing_cols.add('pinned')
  }
  for (const [name, sql_type] of Object.entries(PROPERTY_CURRENT_COLUMNS)) {
    if (!existing_cols.has(name)) {
      conn.exec(`ALTER TABLE properties ADD COLUMN ${name} ${sql_type}`)
    }
  }

  if (!table_exists(conn, 'snapshots')) return

  const rows = conn
    .prepare(
      `SELECT *
       FROM snapshots s
       WHERE s.fetched_at = (
         SELECT MAX(s2.fetched_at)
         FROM snapshots s2
         WHERE s2.property_id = s.property_id
       )`,
    )
    .all() as any[]
  const update = conn.prepare(
    `UPDATE properties SET
       matched_address = COALESCE(?, matched_address),
       best_current_estimate = COALESCE(?, best_current_estimate),
       estimate_source = COALESCE(?, estimate_source),
       estimate_low = COALESCE(?, estimate_low),
       estimate_high = COALESCE(?, estimate_high),
       estimate_date = COALESCE(?, estimate_date),
       list_price = COALESCE(?, list_price),
       sold_price = COALESCE(?, sold_price),
       last_sold_price = COALESCE(?, last_sold_price),
       beds = COALESCE(?, beds),
       baths = COALESCE(?, baths),
       sqft = COALESCE(?, sqft),
       lot_sqft = COALESCE(?, lot_sqft),
       year_built = COALESCE(?, year_built),
       latitude = COALESCE(?, latitude),
       longitude = COALESCE(?, longitude),
       raw_json = COALESCE(?, raw_json),
       error = COALESCE(?, error),
       last_fetched_at = COALESCE(?, last_fetched_at, updated_at),
       status = COALESCE(?, status)
     WHERE id = ?`,
  )
  for (const row of rows) {
    update.run(
      row.matched_address,
      row.best_current_estimate,
      row.estimate_source,
      row.estimate_low,
      row.estimate_high,
      row.estimate_date,
      row.list_price,
      row.sold_price,
      row.last_sold_price,
      row.beds,
      row.baths,
      row.sqft,
      row.lot_sqft,
      row.year_built,
      row.latitude,
      row.longitude,
      row.raw_json,
      row.error,
      row.fetched_at,
      row.status,
      row.property_id,
    )
  }
  conn.exec('DROP TABLE snapshots')
}

// Add the pause/active `status` column to pre-existing area_listings caches.
function migrate_area_listings(conn: Database.Database): void {
  const rows = conn.prepare('SELECT name FROM pragma_table_info(?)').all('area_listings') as any[]
  const cols = new Set(rows.map((r) => r.name))
  if (!cols.has('status')) {
    conn.exec("ALTER TABLE area_listings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
  }
}

function ensure_schema(conn: Database.Database): void {
  conn.exec(SCHEMA)
  conn.exec("DELETE FROM app_settings WHERE key = 'deepseek_api_key'")
  migrate_properties_current_state(conn)
  migrate_area_listings(conn)
}
