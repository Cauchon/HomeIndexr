import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.environ.get("HT_DB_PATH", DATA_DIR / "app.db"))

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(canonical_address)
);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    fetched_at INTEGER NOT NULL,
    status TEXT NOT NULL,
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
    raw_json TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_property ON snapshots(property_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS historical_estimates (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    date TEXT NOT NULL,
    estimate INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (property_id, source, date)
);

CREATE INDEX IF NOT EXISTS idx_hist_property ON historical_estimates(property_id, date);
"""


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
