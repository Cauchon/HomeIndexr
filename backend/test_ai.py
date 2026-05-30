import atexit
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Redirect the database to a throwaway path BEFORE importing app modules, so a
# stray DB access can never touch the real data/app.db. db.db_path() resolves
# lazily, but set this anyway so this file is safe to run in isolation too.
_tmp = tempfile.TemporaryDirectory()
atexit.register(_tmp.cleanup)
os.environ["HOMEINDEXR_DB_PATH"] = os.path.join(_tmp.name, "test.db")
os.environ["HOMEINDEXR_DOTENV_PATH"] = os.path.join(_tmp.name, ".env")

from app import ai, store  # noqa: E402


def _resp(*, ok=True, json_data=None, status=200, text=""):
    m = MagicMock()
    m.ok = ok
    m.status_code = status
    m.text = text
    m.content = b"x"
    m.json.return_value = json_data if json_data is not None else {}
    return m


def _chat(message, usage=None, model="deepseek-v4-flash"):
    return _resp(json_data={"choices": [{"message": message}], "usage": usage or {}, "model": model})


def _tool_call(name, arguments="{}", call_id="call_1"):
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}
        ],
    }


class ToolLoopTests(unittest.TestCase):
    def setUp(self):
        self.prop = {
            "id": 1,
            "canonical_address": "3945 Parker Rd, West Linn, OR 97068",
            "city": "West Linn",
            "latitude": 45.36,
            "longitude": -122.61,
            "raw_json": {},
        }

    @patch.object(store, "get_brave_api_key", return_value="brave-test")
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_reverse_geocode_round_trip(self, *_):
        chats = [
            _chat(_tool_call("reverse_geocode", "{}"), usage={"total_tokens": 100}),
            _chat({"role": "assistant", "content": "It is in the Willamette neighborhood."},
                  usage={"total_tokens": 150}),
        ]
        geo = _resp(json_data={
            "display_name": "Willamette, West Linn, Clackamas County, OR",
            "lat": "45.36", "lon": "-122.61",
            "address": {"neighbourhood": "Willamette", "city": "West Linn", "county": "Clackamas County"},
        })
        with patch.object(ai.requests, "post", side_effect=chats) as post, \
                patch.object(ai.requests, "get", return_value=geo) as get:
            res = ai.answer_property_question(self.prop, "What neighborhood is this in?")

        self.assertIn("Willamette", res["answer"])
        self.assertEqual(res["tools_used"], ["reverse_geocode"])
        self.assertEqual(res["usage"]["total_tokens"], 250)
        self.assertEqual(post.call_count, 2)
        # Tools are offered on the first turn.
        self.assertIn("tools", post.call_args_list[0].kwargs["json"])
        # Geocoder is called with the property's stored coordinates.
        self.assertEqual(get.call_count, 1)
        params = get.call_args.kwargs["params"]
        self.assertEqual(params["lat"], 45.36)
        self.assertEqual(params["lon"], -122.61)
        # The tool result is fed back to the model on the second turn.
        second_messages = post.call_args_list[1].kwargs["json"]["messages"]
        self.assertEqual(second_messages[-1]["role"], "tool")
        self.assertIn("Willamette", second_messages[-1]["content"])

    @patch.object(store, "get_brave_api_key", return_value="brave-test")
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_web_search_tool_used(self, *_):
        chats = [
            _chat(_tool_call("web_search", '{"query": "West Linn schools"}')),
            _chat({"role": "assistant", "content": "Top-rated schools per the district site."}),
        ]
        search = _resp(json_data={"web": {"results": [
            {"title": "West Linn schools", "url": "https://example.com", "description": "Highly rated."}
        ]}})
        with patch.object(ai.requests, "post", side_effect=chats), \
                patch.object(ai.requests, "get", return_value=search) as get:
            res = ai.answer_property_question(self.prop, "How are the schools?")

        self.assertEqual(res["tools_used"], ["web_search"])
        self.assertTrue(res["context"]["web_search_enabled"])
        self.assertIn("/web/search", get.call_args.args[0])

    @patch.object(store, "get_brave_api_key", return_value=None)
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_no_brave_key_omits_web_search_tool(self, *_):
        chats = [_chat({"role": "assistant", "content": "Answer from local data."})]
        with patch.object(ai.requests, "post", side_effect=chats) as post:
            res = ai.answer_property_question(self.prop, "Why did the value change?")

        self.assertEqual(res["tools_used"], [])
        self.assertFalse(res["context"]["web_search_enabled"])
        tools = post.call_args_list[0].kwargs["json"]["tools"]
        names = [t["function"]["name"] for t in tools]
        self.assertNotIn("web_search", names)
        self.assertIn("reverse_geocode", names)
        self.assertIn("geocode_address", names)

    @patch.object(store, "get_brave_api_key", return_value=None)
    @patch.object(store, "get_deepseek_api_key", return_value=None)
    def test_missing_deepseek_key_raises(self, *_):
        with self.assertRaises(ai.AIError):
            ai.answer_property_question(self.prop, "Anything?")

    @patch.object(store, "get_brave_api_key", return_value="brave-test")
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_forced_final_step_drops_tools_and_directs_prose(self, *_):
        # Model keeps calling web_search until the step budget is exhausted, then
        # answers on the forced final turn.
        chats = [_chat(_tool_call("web_search", '{"query": "q"}')) for _ in range(ai.MAX_TOOL_STEPS)]
        chats.append(_chat({"role": "assistant", "content": "Final prose answer."}))
        search = _resp(json_data={"web": {"results": [
            {"title": "t", "url": "https://example.com", "description": "d"}
        ]}})
        with patch.object(ai.requests, "post", side_effect=chats) as post, \
                patch.object(ai.requests, "get", return_value=search):
            res = ai.answer_property_question(self.prop, "What's the neighborhood like?")

        self.assertEqual(res["answer"], "Final prose answer.")
        # The final request forces an answer: no tools offered, and an explicit
        # prose directive is the last message.
        final_payload = post.call_args_list[-1].kwargs["json"]
        self.assertNotIn("tools", final_payload)
        self.assertEqual(final_payload["messages"][-1]["role"], "user")
        self.assertIn("final answer", final_payload["messages"][-1]["content"].lower())

    @patch.object(store, "get_brave_api_key", return_value="brave-test")
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_leaked_tool_markup_is_not_surfaced(self, *_):
        leaked = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="web_search">'
        chats = [_chat({"role": "assistant", "content": leaked})]
        with patch.object(ai.requests, "post", side_effect=chats):
            res = ai.answer_property_question(self.prop, "What's the neighborhood like?")

        self.assertNotIn("DSML", res["answer"])
        self.assertNotIn("invoke name", res["answer"])
        self.assertIn("couldn't compose", res["answer"])

    @patch.object(store, "get_brave_api_key", return_value="brave-test")
    @patch.object(store, "get_deepseek_api_key", return_value="sk-test")
    def test_tool_failure_does_not_crash_loop(self, *_):
        chats = [
            _chat(_tool_call("reverse_geocode", "{}")),
            _chat({"role": "assistant", "content": "Could not determine the neighborhood."}),
        ]
        with patch.object(ai.requests, "post", side_effect=chats), \
                patch.object(ai.requests, "get", side_effect=ai.requests.RequestException("boom")):
            res = ai.answer_property_question(self.prop, "What neighborhood?")

        self.assertIn("neighborhood", res["answer"].lower())
        self.assertEqual(res["tools_used"], ["reverse_geocode"])


if __name__ == "__main__":
    unittest.main()
