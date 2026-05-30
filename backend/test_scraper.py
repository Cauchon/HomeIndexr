import atexit
import os
import tempfile
import unittest
import unittest.mock

# Redirect the database to a throwaway path BEFORE importing app modules so a
# stray DB access can never touch the real data/app.db (see test_main.py).
_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import scraper  # noqa: E402


def ms(date: str) -> int:
    return scraper._parse_date_ms(date)


class NormalizeListingStateTests(unittest.TestCase):
    def test_recent_sold_status_overrides_stale_pending_date(self):
        raw = {
            "status": "sold",
            "mls_status": "Sold",
            "pending_date": "2026-03-31T04:04:43Z",
            "last_sold_date": "2026-05-01",
            "list_price": 689500,
            "listing_id": "2992207803",
        }

        self.assertEqual(
            scraper.normalize_listing_state(raw, now_ms=ms("2026-05-16")),
            "sold",
        )

    def test_pending_status_with_old_prior_sale_stays_pending(self):
        raw = {
            "status": "pending",
            "mls_status": "Pending",
            "pending_date": "2026-04-08T03:14:55Z",
            "last_sold_date": "2018-06-22",
            "list_price": 1249900,
            "listing_id": "150840261",
        }

        self.assertEqual(
            scraper.normalize_listing_state(raw, now_ms=ms("2026-05-16")),
            "pending",
        )

    def test_old_explicit_sold_status_becomes_off_market(self):
        raw = {
            "status": "sold",
            "mls_status": "Sold",
            "pending_date": "2025-01-01T00:00:00Z",
            "last_sold_date": "2025-01-15",
            "listing_id": "old-listing",
        }

        self.assertEqual(
            scraper.normalize_listing_state(raw, now_ms=ms("2026-05-16")),
            "off_market",
        )


class MatchStatusTests(unittest.TestCase):
    def test_multiline_address_with_country_matches_location(self):
        raw = {
            "location": {
                "address": {
                    "line": "18735 Effinger Way",
                    "city": "Oregon City",
                    "state_code": "OR",
                    "postal_code": "97045",
                }
            }
        }

        self.assertEqual(
            scraper._match_status(
                raw,
                "18735 Effinger Way\nOregon City, OR  97045\nUnited States",
            ),
            "matched",
        )

    def test_different_street_still_requires_mismatch_confirmation(self):
        raw = {
            "location": {
                "address": {
                    "line": "18735 Effinger Way",
                    "city": "Oregon City",
                    "state_code": "OR",
                    "postal_code": "97045",
                }
            }
        }

        self.assertEqual(
            scraper._match_status(raw, "18737 Effinger Way, Oregon City, OR 97045"),
            "candidate_mismatch",
        )


class FlattenListingTests(unittest.TestCase):
    def _node(self, **overrides):
        node = {
            "property_id": "8240260738",
            "listing_id": "2996200173",
            "status": "for_sale",
            "list_price": 625000,
            "list_date": "2026-05-29T17:18:13.000000Z",
            "days_on_market": 1,
            "href": "https://www.realtor.com/realestateandhomes-detail/12022-Arcadia-Bend-Ln_Houston_TX_77041_M82402-60738",
            "permalink": "12022-Arcadia-Bend-Ln_Houston_TX_77041_M82402-60738",
            "description": {
                "beds": 4, "baths_full": 3, "baths_half": 1, "sqft": 3100,
                "lot_sqft": 9148, "type": "single_family", "sub_type": None,
                "year_built": 2004,
            },
            "location": {"address": {
                "line": "12022 Arcadia Bend Ln", "city": "houston",
                "state_code": "tx", "postal_code": "77041",
                "coordinate": {"lat": 29.862468, "lon": -95.589335},
            }},
            "primary_photo": {"href": "http://ap.rdcpix.com/x.jpg"},
            "flags": {"is_new_listing": True, "is_price_reduced": None, "is_foreclosure": None},
        }
        node.update(overrides)
        return node

    def test_flatten_listing_projects_card_fields(self):
        flat = scraper._flatten_listing(self._node())
        self.assertEqual(flat["property_id"], "8240260738")
        self.assertEqual(flat["list_price"], 625000)
        self.assertEqual(flat["beds"], 4)
        self.assertEqual(flat["baths"], 3.5)  # 3 full + 1 half
        self.assertEqual(flat["sqft"], 3100)
        self.assertEqual(flat["city"], "Houston")  # title-cased
        self.assertEqual(flat["state"], "TX")  # upper-cased
        self.assertEqual(flat["zip"], "77041")
        self.assertEqual(flat["listing_state"], "for_sale")
        self.assertEqual(flat["photo_url"], "http://ap.rdcpix.com/x.jpg")
        self.assertEqual(flat["is_new_listing"], 1)
        self.assertTrue(flat["property_url"].startswith("https://www.realtor.com/"))

    def test_flatten_listing_requires_property_id(self):
        self.assertIsNone(scraper._flatten_listing({"list_price": 100}))
        self.assertIsNone(scraper._flatten_listing(None))

    def test_fetch_area_listings_filters_and_dedupes(self):
        payload = {"data": {"home_search": {"count": 3, "total": 3, "results": [
            self._node(property_id="A"),
            self._node(property_id="A"),  # duplicate -> dropped
            {"list_price": 1},            # no property_id -> dropped
        ]}}}
        with unittest.mock.patch.object(scraper, "_post_gql", return_value=payload) as post:
            out = scraper.fetch_area_listings("77041", limit=40)
        self.assertEqual([l["property_id"] for l in out], ["A"])
        # Verify the query is sent as a for-sale, single-ZIP, single-page search.
        variables = post.call_args.args[2]
        self.assertEqual(variables["query"], {"status": ["for_sale"], "postal_code": "77041"})
        self.assertEqual(variables["limit"], 40)
        self.assertEqual(variables["offset"], 0)

    def test_fetch_area_listings_empty_zip(self):
        self.assertEqual(scraper.fetch_area_listings(""), [])


if __name__ == "__main__":
    unittest.main()
