import atexit
import os
import tempfile
import unittest
from unittest import mock

# DB-isolation preamble (see test_main.py): redirect before importing app.
_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import browse, db, main, store  # noqa: E402


def _reset_db() -> None:
    base = db.db_path()
    for suffix in ("", "-wal", "-shm"):
        path = base.with_name(base.name + suffix)
        if path.exists():
            path.unlink()
    db.init_db()


def _listing(pid, **overrides):
    out = {
        "property_id": str(pid),
        "line": f"{pid} Main St",
        "city": "Austin",
        "state": "TX",
        "zip": "78704",
        "list_price": 500000,
        "beds": 3,
        "baths": 2.0,
        "sqft": 1500,
        "year_built": 2000,
        "days_on_market": 10,
        "listing_state": "for_sale",
        "photo_url": None,
    }
    out.update(overrides)
    return out


def _fetched(**overrides):
    out = {
        "status": "matched",
        "matched_address": "4901 Bouldin Ave, Austin, TX 78704",
        "city": "Austin",
        "state": "TX",
        "zip": "78704",
        "property_id": "TRACKED1",
        "listing_id": "listing-1",
        "property_url": "/p/x",
        "listing_state": "for_sale",
        "best_current_estimate": 700000,
        "estimate_source": "Cotality",
    }
    out.update(overrides)
    return out


# ---------------------------------------------------------------------------
# Pure aggregation — no DB.
# ---------------------------------------------------------------------------
class BuildPoolTests(unittest.TestCase):
    def test_unions_zips_and_derives_price_per_sqft(self):
        rows = [
            {"zip": "78704", "fetched_at": 200, "listings": [_listing("A", list_price=600000, sqft=2000)]},
            {"zip": "78745", "fetched_at": 100, "listings": [_listing("B", list_price=400000, sqft=1000)]},
        ]
        pool = browse.build_pool(rows)
        ids = {h["property_id"] for h in pool["homes"]}
        self.assertEqual(ids, {"A", "B"})
        self.assertEqual(pool["zips"], ["78704", "78745"])
        self.assertEqual(pool["fetched_at"], 200)  # newest cache wins
        by_id = {h["property_id"]: h for h in pool["homes"]}
        self.assertEqual(by_id["A"]["price_per_sqft"], 300)
        self.assertEqual(by_id["B"]["price_per_sqft"], 400)

    def test_dedupes_by_property_id_newest_zip_first(self):
        rows = [
            {"zip": "78704", "fetched_at": 200, "listings": [_listing("DUP", list_price=600000)]},
            {"zip": "78745", "fetched_at": 100, "listings": [_listing("DUP", list_price=999999)]},
        ]
        pool = browse.build_pool(rows)
        self.assertEqual(len(pool["homes"]), 1)
        self.assertEqual(pool["homes"][0]["list_price"], 600000)

    def test_excludes_tracked_property_ids(self):
        rows = [{"zip": "78704", "fetched_at": 1, "listings": [_listing("KEEP"), _listing("DROP")]}]
        pool = browse.build_pool(rows, exclude_ids={"DROP"})
        self.assertEqual([h["property_id"] for h in pool["homes"]], ["KEEP"])

    def test_skips_listings_without_property_id(self):
        rows = [{"zip": "78704", "fetched_at": 1, "listings": [{"line": "no id"}, _listing("OK")]}]
        pool = browse.build_pool(rows)
        self.assertEqual([h["property_id"] for h in pool["homes"]], ["OK"])

    def test_empty_input(self):
        pool = browse.build_pool(None)
        self.assertEqual(pool, {"homes": [], "zips": [], "fetched_at": None})


class PoolFacetsTests(unittest.TestCase):
    def test_bounds_round_outward_and_histogram_sums(self):
        homes = [
            _listing("A", list_price=410000, sqft=1450, year_built=1990),
            _listing("B", list_price=980000, sqft=2680, year_built=2015),
            _listing("C", list_price=560000, sqft=1820, year_built=2004),
        ]
        facets = browse.pool_facets(homes)
        self.assertEqual(facets["count"], 3)
        # price rounded to 25k step: floor(410000)->400000, ceil(980000)->1000000
        self.assertEqual(facets["bounds"]["price"], [400000, 1000000])
        # sqft rounded to 100 step
        self.assertEqual(facets["bounds"]["sqft"], [1400, 2700])
        self.assertEqual(facets["bounds"]["year"], [1990, 2015])
        self.assertEqual(len(facets["price_hist"]), browse.PRICE_BUCKETS)
        self.assertEqual(sum(facets["price_hist"]), 3)

    def test_status_counts_and_cities(self):
        homes = [
            _listing("A", listing_state="for_sale", city="Austin"),
            _listing("B", listing_state="pending", city="Austin"),
            _listing("C", listing_state="for_sale", city="Round Rock"),
        ]
        facets = browse.pool_facets(homes)
        self.assertEqual(facets["statuses"], {"for_sale": 2, "pending": 1})
        self.assertEqual(facets["cities"], ["Austin", "Round Rock"])

    def test_upper_bounds_capped_at_percentile_not_max(self):
        # 19 ordinary homes + one mansion / one McMansion. The raw max would
        # stretch the slider; the p97 cap keeps the bulk of the pool on-track.
        homes = [
            _listing(i, list_price=400000 + i * 10000, sqft=1400 + i * 20)
            for i in range(19)
        ]
        homes.append(_listing("MANSION", list_price=8_000_000, sqft=12000))
        facets = browse.pool_facets(homes)
        # Cap lands well below the 8M / 12k-sqft outlier, rounded outward to step.
        self.assertLess(facets["bounds"]["price"][1], 1_000_000)
        self.assertLess(facets["bounds"]["sqft"][1], 3_000)
        # Lower bounds stay at the true (rounded) min.
        self.assertEqual(facets["bounds"]["price"][0], 400_000)

    def test_empty_pool_falls_back_to_default_bounds(self):
        facets = browse.pool_facets([])
        self.assertEqual(facets["count"], 0)
        self.assertEqual(facets["bounds"]["price"], list(browse._PRICE_FALLBACK))
        self.assertEqual(sum(facets["price_hist"]), 0)


# ---------------------------------------------------------------------------
# Endpoint — reads the cache only, excludes tracked homes.
# ---------------------------------------------------------------------------
class BrowseEndpointTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_empty_cache_returns_empty_pool(self):
        res = main.get_browse()
        self.assertEqual(res["total"], 0)
        self.assertEqual(res["homes"], [])
        self.assertEqual(res["zips"], [])

    def test_aggregates_cache_and_excludes_tracked(self):
        # A tracked property whose Realtor id matches one cached listing.
        store.create_property("4901 Bouldin Ave, Austin, TX 78704", _fetched(property_id="TRACKED1"))
        store.upsert_area_listings("78704", [
            _listing("TRACKED1", list_price=700000),  # already tracked → excluded
            _listing("FREE1", list_price=450000, sqft=1500),
        ])
        store.upsert_area_listings("78745", [
            _listing("FREE2", list_price=525000, sqft=1750, city="Austin"),
        ])

        res = main.get_browse()
        ids = {h["property_id"] for h in res["homes"]}
        self.assertEqual(ids, {"FREE1", "FREE2"})
        self.assertEqual(res["total"], 2)
        self.assertCountEqual(res["zips"], ["78704", "78745"])
        self.assertIn("price", res["bounds"])
        self.assertEqual(len(res["price_hist"]), browse.PRICE_BUCKETS)
        # derived field present on cards
        self.assertEqual(
            next(h for h in res["homes"] if h["property_id"] == "FREE1")["price_per_sqft"], 300
        )

    def test_never_calls_realtor(self):
        # Opening Browse must not trigger any upstream fetch (rule #14).
        store.upsert_area_listings("78704", [_listing("FREE1")])
        with mock.patch.object(main.scraper, "_post_gql") as gql:
            main.get_browse()
        gql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
