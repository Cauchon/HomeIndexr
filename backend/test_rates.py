import atexit
import os
import tempfile
import unittest
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import db, rates, store  # noqa: E402


def _reset_db() -> None:
    for var in ("FRED_API_KEY", "FRED_API_BASE"):
        os.environ.pop(var, None)
    dotenv_path = os.environ["HOMEINDEXR_DOTENV_PATH"]
    if os.path.exists(dotenv_path):
        os.unlink(dotenv_path)
    base = db.db_path()
    for suffix in ("", "-wal", "-shm"):
        path = base.with_name(base.name + suffix)
        if path.exists():
            path.unlink()
    db.init_db()


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _obs(*pairs):
    return {"observations": [{"date": d, "value": v} for d, v in pairs]}


class RatesTest(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_unavailable_without_key(self):
        out = rates.get_mortgage_rates()
        self.assertFalse(out["available"])
        self.assertFalse(out["key_present"])
        self.assertIsNone(out["rate_30"])
        self.assertIsNone(out["rate_15"])

    def test_fetch_parses_latest_non_missing_and_caches(self):
        os.environ["FRED_API_KEY"] = "test-key"
        # Newest observation is missing (".") — must skip to the prior real one.
        series = {
            "MORTGAGE30US": _obs(("2026-05-29", "."), ("2026-05-22", "6.52")),
            "MORTGAGE15US": _obs(("2026-05-29", "5.74")),
        }

        def fake_get(url, params=None, timeout=None):
            return _FakeResp(series[params["series_id"]])

        with patch.object(rates.requests, "get", side_effect=fake_get) as mock_get:
            out = rates.get_mortgage_rates()
            self.assertTrue(out["available"])
            self.assertEqual(out["rate_30"], 6.52)
            self.assertEqual(out["rate_15"], 5.74)
            self.assertEqual(out["observation_date"], "2026-05-29")
            self.assertEqual(mock_get.call_count, 2)

            # Second call inside the TTL is served from cache — no new fetch.
            again = rates.get_mortgage_rates()
            self.assertEqual(again["rate_30"], 6.52)
            self.assertEqual(mock_get.call_count, 2)

        cached = store.get_cached_mortgage_rates()
        self.assertEqual(cached["rate_30"], 6.52)

    def test_fetch_failure_serves_stale_cache(self):
        os.environ["FRED_API_KEY"] = "test-key"
        store.save_mortgage_rates_cache({
            "source": rates.SOURCE, "rate_30": 6.40, "rate_15": 5.60,
            "observation_date": "2026-05-15", "fetched_at": 1,  # ancient → stale
        })
        with patch.object(rates.requests, "get", side_effect=RuntimeError("network down")):
            out = rates.get_mortgage_rates()
        self.assertTrue(out["available"])
        self.assertTrue(out.get("stale"))
        self.assertEqual(out["rate_30"], 6.40)

    def test_fetch_failure_without_cache_is_unavailable(self):
        os.environ["FRED_API_KEY"] = "test-key"
        with patch.object(rates.requests, "get", side_effect=RuntimeError("network down")):
            out = rates.get_mortgage_rates()
        self.assertFalse(out["available"])
        self.assertEqual(out.get("error"), "fetch failed")


if __name__ == "__main__":
    unittest.main()
