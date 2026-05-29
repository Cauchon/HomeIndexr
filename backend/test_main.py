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


if __name__ == "__main__":
    unittest.main()
