import atexit
import os
import tempfile
import unittest

# DB-isolation preamble (see test_main.py): redirect before importing app.
_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import comps  # noqa: E402


def _subject(**overrides):
    s = {
        "property_type": "single_family",
        "beds": 4, "baths": 3.0, "sqft": 2000, "lot_sqft": 8000,
        "year_built": 2000, "latitude": 29.0, "longitude": -95.0,
        "list_price": 600000,
    }
    s.update(overrides)
    return s


def _listing(pid, **overrides):
    out = {"property_id": pid}
    out.update(overrides)
    return out


class HaversineTests(unittest.TestCase):
    def test_zero_distance(self):
        self.assertEqual(comps.haversine_miles(29.0, -95.0, 29.0, -95.0), 0.0)

    def test_one_degree_latitude_is_about_69_miles(self):
        d = comps.haversine_miles(0.0, 0.0, 1.0, 0.0)
        self.assertAlmostEqual(d, 69.09, delta=0.5)

    def test_missing_coordinate_returns_none(self):
        self.assertIsNone(comps.haversine_miles(29.0, None, 29.0, -95.0))


class PricePerSqftTests(unittest.TestCase):
    def test_rounds(self):
        self.assertEqual(comps.price_per_sqft(610000, 2050), 298)

    def test_missing_sqft_returns_none(self):
        self.assertIsNone(comps.price_per_sqft(600000, None))
        self.assertIsNone(comps.price_per_sqft(600000, 0))


class GateTests(unittest.TestCase):
    def test_missing_sqft_candidate_excluded_when_others_qualify(self):
        res = comps.rank_comparables(_subject(), [
            _listing("nosqft", property_type="single_family", beds=4, list_price=500000),
            _listing("good", property_type="single_family", beds=4, sqft=2100, list_price=610000),
        ])
        self.assertEqual([c["property_id"] for c in res["comps"]], ["good"])
        self.assertIsNone(res["relaxed"])

    def test_oversized_excluded_by_sqft_gate(self):
        res = comps.rank_comparables(_subject(sqft=2000), [
            _listing("big", property_type="single_family", beds=4, sqft=3000, list_price=900000),
            _listing("ok", property_type="single_family", beds=4, sqft=2200, list_price=650000),
        ])
        self.assertEqual([c["property_id"] for c in res["comps"]], ["ok"])


class RankingTests(unittest.TestCase):
    def test_closer_match_ranks_first(self):
        res = comps.rank_comparables(_subject(), [
            _listing("far", property_type="single_family", beds=5, sqft=2400,
                     year_built=1980, latitude=29.04, longitude=-95.04, list_price=700000),
            _listing("near", property_type="single_family", beds=4, sqft=2010,
                     year_built=2001, latitude=29.001, longitude=-95.001, list_price=605000),
        ])
        self.assertEqual([c["property_id"] for c in res["comps"]], ["near", "far"])
        self.assertGreater(res["comps"][0]["comp_score"], res["comps"][1]["comp_score"])
        self.assertIsNotNone(res["comps"][0]["distance_mi"])

    def test_limit_caps_results(self):
        listings = [
            _listing(f"c{i}", property_type="single_family", beds=4, sqft=2000 + i * 10, list_price=600000)
            for i in range(10)
        ]
        res = comps.rank_comparables(_subject(), listings, limit=6)
        self.assertEqual(len(res["comps"]), 6)


class FallbackTests(unittest.TestCase):
    def test_falls_back_to_nearest_when_no_strict_comps(self):
        # All candidates fail type/sqft gates; only the 'nearest' rung returns them.
        res = comps.rank_comparables(_subject(sqft=2000), [
            _listing("condo", property_type="condo", sqft=2000, beds=4, list_price=600000),
            _listing("huge", property_type="single_family", sqft=5000, beds=8, list_price=1500000),
        ])
        self.assertEqual(res["relaxed"], "showing the nearest matches")
        self.assertEqual(len(res["comps"]), 2)

    def test_widened_sqft_rung_labeled(self):
        # 2700 sqft is outside ±25% (2500) but inside ±40% (2800) of 2000.
        res = comps.rank_comparables(_subject(sqft=2000), [
            _listing("widish", property_type="single_family", beds=4, sqft=2700, list_price=800000),
        ])
        self.assertEqual([c["property_id"] for c in res["comps"]], ["widish"])
        self.assertEqual(res["relaxed"], "widened the size range to ±40%")


class SubjectDataTests(unittest.TestCase):
    def test_limited_flag_when_subject_lacks_sqft(self):
        res = comps.rank_comparables(_subject(sqft=None), [
            _listing("c", property_type="single_family", beds=4, sqft=2000, list_price=600000),
        ])
        self.assertTrue(res["limited"])
        self.assertIsNone(res["subject_price_per_sqft"])
        # Without a subject sqft, the sqft gate can't apply but type/beds still do.
        self.assertEqual([c["property_id"] for c in res["comps"]], ["c"])

    def test_subject_ppsf_uses_estimate_when_no_list_price(self):
        res = comps.rank_comparables(
            _subject(list_price=None, best_current_estimate=620000, sqft=2000),
            [],
        )
        self.assertEqual(res["subject_price_per_sqft"], 310)  # 620000 / 2000


if __name__ == "__main__":
    unittest.main()
