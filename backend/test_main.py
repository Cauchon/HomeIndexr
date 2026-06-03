import atexit
import os
import tempfile
import unittest
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import db, main, store  # noqa: E402


def _reset_db() -> None:
    os.environ.pop("DEEPSEEK_API_KEY", None)
    dotenv_path = os.environ["HOMEINDEXR_DOTENV_PATH"]
    if os.path.exists(dotenv_path):
        os.unlink(dotenv_path)
    base = db.db_path()
    for suffix in ("", "-wal", "-shm"):
        path = base.with_name(base.name + suffix)
        if path.exists():
            path.unlink()
    db.init_db()


def _fetched(**overrides):
    out = {
        "status": "matched",
        "matched_address": "5907 Cape Hatteras Dr, Houston, TX 77041",
        "city": "Houston",
        "state": "TX",
        "zip": "77041",
        "property_id": "12345",
        "listing_id": "listing-1",
        "property_url": "/realestateandhomes-detail/5907-Cape-Hatteras-Dr_Houston_TX_77041_M12345",
        "listing_state": "off_market",
        "best_current_estimate": 420000,
        "estimate_source": "Cotality",
        "estimate_low": 400000,
        "estimate_high": 440000,
        "estimate_date": "2026-05-01",
        "raw_json": {"property_id": "12345"},
        "schools": [],
    }
    out.update(overrides)
    return out


def _bundle():
    return {
        "estimates": [
            {"source": "Cotality", "date": "2026-04-01", "estimate": 415000},
            {"source": "Quantarium", "date": "2026-04-01", "estimate": 418000},
        ],
        "events": [
            {"date": "2021-03-15", "event_name": "Sold", "price": 350000},
        ],
        "taxes": [
            {"year": 2025, "tax": 8100, "assessment_total": 390000},
        ],
    }


class AddPropertyBackfillTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    @patch.object(main.scraper, "fetch_history_bundle", return_value=_bundle())
    @patch.object(main.scraper, "fetch", return_value=_fetched())
    def test_add_property_backfills_history_before_returning(
        self,
        fetch,
        fetch_history_bundle,
    ):
        res = main.add_property(main.AddBody(address="5907 Cape Hatteras Dr, Houston, TX 77041"))

        prop = res["property"]
        self.assertEqual(res["status"], "matched")
        self.assertEqual(res["backfill"]["written"], 2)
        self.assertEqual(res["backfill"]["events_written"], 1)
        self.assertEqual(res["backfill"]["taxes_written"], 1)
        self.assertEqual(len(prop["historical"]), 2)
        self.assertEqual(len(prop["events"]), 1)
        self.assertEqual(len(prop["tax_history"]), 1)
        fetch.assert_called_once()
        fetch_history_bundle.assert_called_once_with("12345")

    @patch.object(main.scraper, "fetch_history_bundle", return_value=_bundle())
    @patch.object(main.scraper, "fetch", return_value=_fetched(best_current_estimate=430000))
    def test_readding_existing_property_refreshes_and_backfills(
        self,
        fetch,
        fetch_history_bundle,
    ):
        first = store.create_property(
            "5907 Cape Hatteras Dr, Houston, TX 77041",
            _fetched(best_current_estimate=410000),
        )

        res = main.add_property(main.AddBody(address="5907 Cape Hatteras Dr, Houston, TX 77041"))

        self.assertEqual(res["property"]["id"], first["id"])
        self.assertEqual(res["property"]["best_current_estimate"], 430000)
        self.assertEqual(len(res["property"]["historical"]), 2)
        fetch.assert_called_once()
        fetch_history_bundle.assert_called_once_with("12345")


class MismatchPersistenceTests(unittest.TestCase):
    """A tracked property's match is accepted, so `candidate_mismatch` is never
    persisted — only the add-time gate uses it (to block unconfirmed new adds)."""

    def setUp(self):
        _reset_db()

    def test_unconfirmed_new_mismatch_is_gated_not_persisted(self):
        with patch.object(main.scraper, "fetch", return_value=_fetched(status="candidate_mismatch")):
            res = main.add_property(main.AddBody(address="118 prospect st framingham ma"))
        self.assertEqual(res["status"], "candidate_mismatch")
        self.assertIsNone(res["property"])
        self.assertIsNotNone(res["candidate"])
        self.assertEqual(store.list_properties(), [])

    @patch.object(main.scraper, "fetch_history_bundle", return_value=_bundle())
    @patch.object(main.scraper, "fetch", return_value=_fetched(status="candidate_mismatch"))
    def test_confirmed_mismatch_persists_as_matched(self, fetch, _bundle_fetch):
        res = main.add_property(
            main.AddBody(address="118 prospect st framingham ma", confirm_mismatch=True)
        )
        self.assertIsNotNone(res["property"])
        self.assertEqual(res["property"]["status"], "matched")

    def test_refresh_of_tracked_property_does_not_reflag_mismatch(self):
        prop = store.create_property("118 prospect st framingham ma", _fetched())
        self.assertEqual(prop["status"], "matched")
        store.update_property_meta(prop["id"], _fetched(status="candidate_mismatch"))
        self.assertEqual(store.get_property(prop["id"])["status"], "matched")

    def test_genuine_problem_status_still_surfaces_on_refresh(self):
        prop = store.create_property("5907 Cape Hatteras Dr, Houston, TX 77041", _fetched())
        store.update_property_meta(prop["id"], _fetched(status="error", error="boom"))
        self.assertEqual(store.get_property(prop["id"])["status"], "error")

    @patch.object(main.scraper, "fetch_area_listings", return_value=[])
    def test_refresh_all_reports_persisted_status_not_raw(self, _area):
        prop = store.create_property("118 prospect st framingham ma", _fetched())
        with patch.object(main.scraper, "fetch", return_value=_fetched(status="candidate_mismatch")):
            res = main.refresh_all()
        # The job log counts result.status != "matched"; it must agree with what
        # was actually persisted (matched), not the raw recomputed mismatch.
        statuses = [r["status"] for r in res["results"] if r["id"] == prop["id"]]
        self.assertEqual(statuses, ["matched"])


class AISettingsTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_ai_settings_default_to_disabled_without_key(self):
        settings = main.get_ai_settings()

        self.assertFalse(settings["enabled"])
        self.assertEqual(settings["provider"], "deepseek")
        self.assertFalse(settings["has_deepseek_api_key"])
        self.assertIsNone(settings["deepseek_api_key_source"])
        self.assertEqual(settings["deepseek_api_key_env_var"], "DEEPSEEK_API_KEY")

    def test_ai_settings_detect_deepseek_key_from_environment(self):
        os.environ["DEEPSEEK_API_KEY"] = "sk-test-secret-1234"

        settings = main.update_ai_settings(main.AISettingsBody(enabled=True))

        self.assertTrue(settings["enabled"])
        self.assertTrue(settings["has_deepseek_api_key"])
        self.assertEqual(settings["deepseek_api_key_source"], "environment")
        self.assertNotIn("sk-test-secret-1234", settings.values())

        fetched_again = main.get_ai_settings()
        self.assertTrue(fetched_again["enabled"])
        self.assertEqual(fetched_again["deepseek_api_key_source"], "environment")

    def test_ai_settings_detect_deepseek_key_from_dotenv(self):
        with open(os.environ["HOMEINDEXR_DOTENV_PATH"], "w") as f:
            f.write("DEEPSEEK_API_KEY=sk-dotenv-secret-1234\n")

        settings = main.get_ai_settings()

        self.assertTrue(settings["has_deepseek_api_key"])
        self.assertEqual(settings["deepseek_api_key_source"], "dotenv")
        self.assertNotIn("sk-dotenv-secret-1234", settings.values())

    def test_ai_settings_delete_legacy_db_secret(self):
        with db.get_conn() as conn:
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES ('deepseek_api_key', 'sk-legacy-secret', 1)"
            )

        settings = main.update_ai_settings(main.AISettingsBody(enabled=True))

        self.assertTrue(settings["enabled"])
        self.assertFalse(settings["has_deepseek_api_key"])
        with db.get_conn() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = 'deepseek_api_key'").fetchone()
        self.assertIsNone(row)


class PropertyAIQuestionTests(unittest.TestCase):
    def setUp(self):
        _reset_db()
        self.prop = store.create_property("123 Main St", _fetched())

    def test_ask_property_ai_requires_enabled_feature(self):
        os.environ["DEEPSEEK_API_KEY"] = "sk-test-secret-1234"

        with self.assertRaises(main.HTTPException) as ctx:
            main.ask_property_ai(self.prop["id"], main.AIQuestionBody(question="Why did value drop?"))

        self.assertEqual(ctx.exception.status_code, 403)

    def test_ask_property_ai_requires_key(self):
        store.save_ai_settings(enabled=True)

        with self.assertRaises(main.HTTPException) as ctx:
            main.ask_property_ai(self.prop["id"], main.AIQuestionBody(question="Why did value drop?"))

        self.assertEqual(ctx.exception.status_code, 400)

    @patch.object(main.ai, "answer_property_question", return_value={"answer": "Likely list price pressure.", "model": "deepseek-v4-flash", "usage": {}})
    def test_ask_property_ai_uses_related_property_context(self, answer_property_question):
        os.environ["DEEPSEEK_API_KEY"] = "sk-test-secret-1234"
        store.save_ai_settings(enabled=True)
        store.replace_events(self.prop["id"], [{"date": "2026-05-20", "event_name": "Price Changed", "price": 405000}])

        res = main.ask_property_ai(self.prop["id"], main.AIQuestionBody(question="Why did value drop on May 20?"))

        self.assertEqual(res["answer"], "Likely list price pressure.")
        called_prop, called_question = answer_property_question.call_args.args
        self.assertEqual(called_prop["id"], self.prop["id"])
        self.assertEqual(len(called_prop["events"]), 1)
        self.assertEqual(called_question, "Why did value drop on May 20?")


class ObservedPriceEventTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_refresh_records_price_drop_for_active_listing(self):
        prop = store.create_property(
            "5907 Cape Hatteras Dr, Houston, TX 77041",
            _fetched(
                listing_state="for_sale",
                list_price=700000,
                raw_json={"status": "for_sale", "list_price": 700000, "listing_id": "listing-1"},
            ),
        )

        event = store.update_property_meta(
            prop["id"],
            _fetched(
                listing_state="for_sale",
                list_price=675000,
                raw_json={"status": "for_sale", "list_price": 675000, "listing_id": "listing-1"},
            ),
        )

        self.assertIsNotNone(event)
        self.assertEqual(event["event_name"], "Price dropped")
        self.assertEqual(event["old_price"], 700000)
        self.assertEqual(event["new_price"], 675000)
        self.assertEqual(event["delta"], -25000)

        events = store.list_events(prop["id"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["source"], "observed")
        self.assertEqual(events[0]["event_name"], "Price dropped")
        self.assertEqual(events[0]["price"], 675000)
        self.assertEqual(events[0]["old_price"], 700000)
        self.assertEqual(events[0]["new_price"], 675000)

        store.replace_events(prop["id"], [{"date": "2021-03-15", "event_name": "Sold", "price": 350000}])
        merged = store.list_events(prop["id"])
        self.assertEqual([e["source"] for e in merged], ["realtor", "observed"])

    def test_refresh_does_not_record_price_change_for_new_listing_id(self):
        prop = store.create_property(
            "5907 Cape Hatteras Dr, Houston, TX 77041",
            _fetched(
                listing_state="for_sale",
                list_price=700000,
                listing_id="listing-1",
                raw_json={"status": "for_sale", "list_price": 700000, "listing_id": "listing-1"},
            ),
        )

        event = store.update_property_meta(
            prop["id"],
            _fetched(
                listing_state="for_sale",
                list_price=675000,
                listing_id="listing-2",
                raw_json={"status": "for_sale", "list_price": 675000, "listing_id": "listing-2"},
            ),
        )

        self.assertIsNone(event)
        self.assertEqual(store.list_events(prop["id"]), [])


class PinnedPropertyTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_default_not_pinned(self):
        prop = store.create_property("123 Main St", _fetched())
        self.assertFalse(prop["pinned"])

    def test_update_pinned_status(self):
        prop = store.create_property("123 Main St", _fetched())
        updated = store.update_property(prop["id"], {"pinned": True})
        self.assertTrue(updated["pinned"])

        # Verify persistence
        fetched_again = store.get_property(prop["id"])
        self.assertTrue(fetched_again["pinned"])

        # Toggle back to False
        updated2 = store.update_property(prop["id"], {"pinned": False})
        self.assertFalse(updated2["pinned"])

        # Verify persistence
        fetched_again2 = store.get_property(prop["id"])
        self.assertFalse(fetched_again2["pinned"])


class PropertyNameTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_update_optional_property_name(self):
        prop = store.create_property("123 Main St", _fetched())

        updated = store.update_property(prop["id"], {"property_name": "  Mom and Dad's house  "})

        self.assertEqual(updated["property_name"], "Mom and Dad's house")
        fetched_again = store.get_property(prop["id"])
        self.assertEqual(fetched_again["property_name"], "Mom and Dad's house")

    def test_blank_property_name_clears_value(self):
        prop = store.create_property("123 Main St", _fetched())
        store.update_property(prop["id"], {"property_name": "Lake house"})

        updated = store.update_property(prop["id"], {"property_name": "   "})

        self.assertIsNone(updated["property_name"])


class AreaListingsTests(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def _seed(self, property_id="12345", zip_code="77041"):
        return store.create_property(
            f"addr {property_id}",
            _fetched(property_id=property_id, zip=zip_code, matched_address=f"addr {property_id}"),
        )

    def test_area_endpoint_ranks_comps_and_excludes_subject(self):
        # Subject is a 4bd/2000sqft single_family; one true comp, one off-type.
        prop = store.create_property(
            "subject addr",
            _fetched(property_id="12345", zip="77041", matched_address="subject addr",
                     property_type="single_family", beds=4, baths=2.0, sqft=2000,
                     year_built=2000, latitude=29.0, longitude=-95.0, list_price=600000),
        )
        store.upsert_area_listings("77041", [
            {"property_id": "12345", "line": "the subject home", "property_type": "single_family", "sqft": 2000, "beds": 4},
            {"property_id": "comp", "line": "a close comp", "list_price": 610000,
             "property_type": "single_family", "beds": 4, "baths": 2.0, "sqft": 2050,
             "year_built": 2002, "latitude": 29.001, "longitude": -95.001},
            {"property_id": "condo", "line": "an off-type condo", "list_price": 600000,
             "property_type": "condo", "beds": 4, "sqft": 2000},
        ])

        res = main.get_property_area(prop["id"])

        self.assertEqual(res["zip"], "77041")
        # Subject excluded; condo gated out; only the same-type comp survives.
        self.assertEqual([l["property_id"] for l in res["comps"]], ["comp"])
        self.assertIsNone(res["relaxed"])
        self.assertEqual(res["comps"][0]["price_per_sqft"], 298)  # 610000 / 2050
        self.assertEqual(res["subject_price_per_sqft"], 300)       # 600000 / 2000
        self.assertGreater(res["comps"][0]["comp_score"], 80)
        self.assertIsNotNone(res["fetched_at"])

    def test_area_endpoint_empty_without_cache(self):
        prop = self._seed()
        res = main.get_property_area(prop["id"])
        self.assertEqual(res["comps"], [])
        self.assertIsNone(res["fetched_at"])

    @patch.object(store.scraper, "fetch_area_listings", return_value=[{"property_id": "777"}])
    @patch.object(main.scraper, "fetch_history_bundle", return_value=_bundle())
    @patch.object(main.scraper, "fetch")
    def test_refresh_property_populates_area_cache(self, fetch, _hist, fetch_area):
        prop = self._seed(property_id="12345", zip_code="77041")
        fetch.return_value = _fetched(property_id="12345", zip="77041", matched_address="addr 12345")

        main.refresh_property(prop["id"])

        fetch_area.assert_called_once_with("77041")
        self.assertEqual(store.get_area_listings("77041")["listings"], [{"property_id": "777"}])

    @patch.object(store.scraper, "fetch_area_listings", return_value=[])
    @patch.object(main.scraper, "fetch")
    def test_refresh_all_dedupes_area_fetch_by_zip(self, fetch, fetch_area):
        self._seed(property_id="1", zip_code="77041")
        self._seed(property_id="2", zip_code="77041")
        self._seed(property_id="3", zip_code="77002")

        def _f(addr):
            zip_code = "77002" if addr.endswith(" 3") else "77041"
            return _fetched(property_id="x", zip=zip_code, matched_address=addr)

        fetch.side_effect = _f

        res = main.refresh_all()

        self.assertEqual(res["areas_refreshed"], 2)
        called_zips = sorted(c.args[0] for c in fetch_area.call_args_list)
        self.assertEqual(called_zips, ["77002", "77041"])


class TrackedAreasTest(unittest.TestCase):
    """Admin → Tracked areas: coverage list, add/recrawl crawl, pause, remove."""

    def setUp(self):
        _reset_db()

    def _seed(self, property_id="12345", zip_code="77041"):
        return store.create_property(
            f"addr {property_id}",
            _fetched(property_id=property_id, zip=zip_code, matched_address=f"addr {property_id}"),
        )

    def test_coverage_lists_zip_with_count_and_locality(self):
        store.upsert_area_listings("77041", [
            {"property_id": "a", "city": "Houston", "state": "TX"},
            {"property_id": "b", "city": "Houston", "state": "TX"},
        ])
        rows = main.list_areas()
        self.assertEqual(len(rows), 1)
        rec = rows[0]
        self.assertEqual(rec["zip"], "77041")
        self.assertEqual(rec["count"], 2)
        self.assertEqual(rec["city"], "Houston")
        self.assertEqual(rec["state"], "TX")
        self.assertEqual(rec["status"], "active")
        # No tracked property in this ZIP → manual origin, removable.
        self.assertEqual(rec["origin"], "manual")
        self.assertFalse(rec["locked"])

    def test_zip_backing_active_property_is_locked(self):
        self._seed(property_id="12345", zip_code="77041")
        store.upsert_area_listings("77041", [{"property_id": "x", "city": "Houston", "state": "TX"}])
        rec = main.list_areas()[0]
        self.assertEqual(rec["origin"], "property")
        self.assertTrue(rec["locked"])
        # Locked ZIP can't be removed.
        with self.assertRaises(main.HTTPException) as ctx:
            main.remove_area("77041")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertTrue(store.area_zip_exists("77041"))

    @patch.object(store.scraper, "fetch_area_listings",
                  return_value=[{"property_id": "n1", "city": "Austin", "state": "TX"}])
    def test_add_area_crawls_and_returns_record(self, fetch_area):
        rec = main.add_area(main.AddZipBody(zip="78704"))
        fetch_area.assert_called_once_with("78704")
        self.assertEqual(rec["zip"], "78704")
        self.assertEqual(rec["count"], 1)
        self.assertEqual(rec["city"], "Austin")
        self.assertTrue(store.area_zip_exists("78704"))

    def test_add_area_rejects_bad_and_duplicate_zip(self):
        with self.assertRaises(main.HTTPException) as bad:
            main.add_area(main.AddZipBody(zip="78"))
        self.assertEqual(bad.exception.status_code, 400)

        store.upsert_area_listings("78704", [{"property_id": "z"}])
        with self.assertRaises(main.HTTPException) as dup:
            main.add_area(main.AddZipBody(zip="78704"))
        self.assertEqual(dup.exception.status_code, 409)

    @patch.object(store.scraper, "fetch_area_listings",
                  side_effect=RuntimeError("blocked"))
    def test_add_area_surfaces_crawl_failure(self, _fetch):
        with self.assertRaises(main.HTTPException) as ctx:
            main.add_area(main.AddZipBody(zip="78704"))
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertFalse(store.area_zip_exists("78704"))

    @patch.object(store.scraper, "fetch_area_listings",
                  return_value=[{"property_id": "r1"}, {"property_id": "r2"}])
    def test_recrawl_refreshes_count(self, _fetch):
        store.upsert_area_listings("78704", [{"property_id": "old"}])
        rec = main.recrawl_area("78704")
        self.assertEqual(rec["count"], 2)

    def test_recrawl_unknown_zip_404(self):
        with self.assertRaises(main.HTTPException) as ctx:
            main.recrawl_area("00000")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_pause_hides_zip_from_browse_but_keeps_index(self):
        store.upsert_area_listings("78704", [
            {"property_id": "h1", "city": "Austin", "state": "TX",
             "list_price": 500000, "listing_state": "for_sale"},
        ])
        self.assertEqual(main.get_browse()["total"], 1)

        rec = main.update_area("78704", main.AreaStatusBody(status="paused"))
        self.assertEqual(rec["status"], "paused")
        # Index is retained, but Browse drops the paused ZIP.
        self.assertTrue(store.area_zip_exists("78704"))
        self.assertEqual(main.get_browse()["total"], 0)

        # Resume restores it without a re-crawl.
        main.update_area("78704", main.AreaStatusBody(status="active"))
        self.assertEqual(main.get_browse()["total"], 1)

    def test_update_area_rejects_bad_status(self):
        store.upsert_area_listings("78704", [{"property_id": "z"}])
        with self.assertRaises(main.HTTPException) as ctx:
            main.update_area("78704", main.AreaStatusBody(status="bogus"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_remove_manual_zip_discards_index(self):
        store.upsert_area_listings("78704", [{"property_id": "z"}])
        res = main.remove_area("78704")
        self.assertEqual(res["zip"], "78704")
        self.assertFalse(store.area_zip_exists("78704"))


if __name__ == "__main__":
    unittest.main()
