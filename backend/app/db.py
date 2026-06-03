import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"


def db_path() -> Path:
    """Resolve the SQLite path at call time, NOT at import.

    Resolving lazily means tests can redirect the database via
    ``HOMEINDEXR_DB_PATH`` regardless of import order. Binding this at import
    time once froze the path to the real ``data/app.db`` when a test module
    imported this module before setting the env var, and a test reset then wiped
    real user data. Never reintroduce an import-time ``DB_PATH`` constant.
    """
    return Path(
        os.environ.get("HOMEINDEXR_DB_PATH")
        or os.environ.get("HT_DB_PATH")
        or (DATA_DIR / "app.db")
    )


_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_conn():
    with _lock:
        conn = _connect()
        try:
            yield conn
        finally:
            conn.close()


SCHEMA = """
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
"""


PROPERTY_CURRENT_COLUMNS = {
    "property_name": "TEXT",
    "matched_address": "TEXT",
    "best_current_estimate": "INTEGER",
    "estimate_source": "TEXT",
    "estimate_low": "INTEGER",
    "estimate_high": "INTEGER",
    "estimate_date": "TEXT",
    "list_price": "INTEGER",
    "sold_price": "INTEGER",
    "last_sold_price": "INTEGER",
    "beds": "INTEGER",
    "baths": "REAL",
    "sqft": "INTEGER",
    "lot_sqft": "INTEGER",
    "year_built": "INTEGER",
    "latitude": "REAL",
    "longitude": "REAL",
    "list_date": "TEXT",
    "days_on_market": "INTEGER",
    "last_price_change_amount": "INTEGER",
    "last_price_change_date": "TEXT",
    "hoa_fee": "INTEGER",
    "property_type": "TEXT",
    "property_sub_type": "TEXT",
    "stories": "INTEGER",
    "garage": "INTEGER",
    "garage_type": "TEXT",
    "pool": "TEXT",
    "cooling": "TEXT",
    "heating": "TEXT",
    "fireplace": "TEXT",
    "is_new_listing": "INTEGER",
    "is_price_reduced": "INTEGER",
    "is_foreclosure": "INTEGER",
    "flood_factor_score": "INTEGER",
    "flood_factor_severity": "TEXT",
    "raw_json": "TEXT",
    "error": "TEXT",
    "last_fetched_at": "INTEGER",
    "pinned": "INTEGER NOT NULL DEFAULT 0",
}


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _property_columns(conn: sqlite3.Connection) -> set[str]:
    return {r["name"] for r in conn.execute("PRAGMA table_info(properties)")}


def _migrate_properties_current_state(conn: sqlite3.Connection) -> None:
    existing_cols = _property_columns(conn)
    if "pinned" not in existing_cols and "favorited" in existing_cols:
        conn.execute("ALTER TABLE properties ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE properties SET pinned = favorited")
        existing_cols.add("pinned")
    for name, sql_type in PROPERTY_CURRENT_COLUMNS.items():
        if name not in existing_cols:
            conn.execute(f"ALTER TABLE properties ADD COLUMN {name} {sql_type}")

    if not _table_exists(conn, "snapshots"):
        return

    rows = conn.execute(
        """SELECT *
           FROM snapshots s
           WHERE s.fetched_at = (
             SELECT MAX(s2.fetched_at)
             FROM snapshots s2
             WHERE s2.property_id = s.property_id
           )"""
    ).fetchall()
    for row in rows:
        conn.execute(
            """UPDATE properties SET
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
               WHERE id = ?""",
            (
                row["matched_address"],
                row["best_current_estimate"],
                row["estimate_source"],
                row["estimate_low"],
                row["estimate_high"],
                row["estimate_date"],
                row["list_price"],
                row["sold_price"],
                row["last_sold_price"],
                row["beds"],
                row["baths"],
                row["sqft"],
                row["lot_sqft"],
                row["year_built"],
                row["latitude"],
                row["longitude"],
                row["raw_json"],
                row["error"],
                row["fetched_at"],
                row["status"],
                row["property_id"],
            ),
        )
    conn.execute("DROP TABLE snapshots")


def _migrate_area_listings(conn: sqlite3.Connection) -> None:
    """Add the pause/active `status` column to pre-existing area_listings caches.

    The Tracked areas admin surface lets a user pause a ZIP (keep its crawled
    index but hide its homes from Browse). Older databases predate the column —
    backfill it so the Browse pool can filter on it.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(area_listings)")}
    if "status" not in cols:
        conn.execute(
            "ALTER TABLE area_listings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
        )


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        conn.execute("DELETE FROM app_settings WHERE key = 'deepseek_api_key'")
        _migrate_properties_current_state(conn)
        _migrate_area_listings(conn)
