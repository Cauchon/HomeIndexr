import unittest

from app import scraper


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


if __name__ == "__main__":
    unittest.main()
