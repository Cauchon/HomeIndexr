import atexit
import os
import tempfile
import unittest

from fastapi import HTTPException

_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import db, main, store  # noqa: E402


def _reset_db() -> None:
    base = db.db_path()
    for suffix in ("", "-wal", "-shm"):
        path = base.with_name(base.name + suffix)
        if path.exists():
            path.unlink()
    db.init_db()


class SavedSearchStoreTest(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_create_returns_record_with_server_id(self):
        rec = store.create_saved_search("Cheap 3-beds", {"min_beds": 3, "max_price": 400000})
        self.assertTrue(rec["id"].startswith("ss_"))
        self.assertEqual(rec["name"], "Cheap 3-beds")
        self.assertEqual(rec["filters"], {"min_beds": 3, "max_price": 400000})
        self.assertIsInstance(rec["created_at"], int)

    def test_list_is_newest_first(self):
        a = store.create_saved_search("first", {})
        b = store.create_saved_search("second", {})
        ids = [s["id"] for s in store.list_saved_searches()]
        # Newest first; created_at ties broken by id DESC so order is stable.
        self.assertEqual(ids, [b["id"], a["id"]])

    def test_filters_round_trip(self):
        store.create_saved_search("complex", {"cities": ["Houston", "Katy"], "status": "for_sale"})
        loaded = store.list_saved_searches()[0]
        self.assertEqual(loaded["filters"], {"cities": ["Houston", "Katy"], "status": "for_sale"})

    def test_blank_name_falls_back(self):
        rec = store.create_saved_search("   ", {})
        self.assertEqual(rec["name"], "Saved search")

    def test_none_filters_become_empty(self):
        rec = store.create_saved_search("no filters", None)
        self.assertEqual(rec["filters"], {})

    def test_delete_removes(self):
        rec = store.create_saved_search("temp", {})
        self.assertTrue(store.delete_saved_search(rec["id"]))
        self.assertEqual(store.list_saved_searches(), [])

    def test_delete_missing_returns_false(self):
        self.assertFalse(store.delete_saved_search("ss_nope"))


class SavedSearchRouteTest(unittest.TestCase):
    def setUp(self):
        _reset_db()

    def test_create_list_delete_flow(self):
        created = main.create_saved_search(main.SavedSearchBody(name="My search", filters={"min_beds": 2}))
        self.assertEqual(created["name"], "My search")

        listed = main.list_saved_searches()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], created["id"])

        result = main.delete_saved_search(created["id"])
        self.assertEqual(result, {"ok": True, "id": created["id"]})
        self.assertEqual(main.list_saved_searches(), [])

    def test_delete_missing_404(self):
        with self.assertRaises(HTTPException) as ctx:
            main.delete_saved_search("ss_missing")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_default_filters_empty(self):
        created = main.create_saved_search(main.SavedSearchBody(name="bare"))
        self.assertEqual(created["filters"], {})


if __name__ == "__main__":
    unittest.main()
