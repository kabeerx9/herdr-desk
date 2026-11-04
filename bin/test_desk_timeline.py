"""team timeline / session title: built from fixture Claude transcripts, never the real ones."""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import desk_runtime as rt


def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".%03dZ" % (ms % 1000)


class Transcript:
    """Writes entries shaped like Claude Code's (keys verified against real transcripts)."""

    def __init__(self, folder, conversation="conv-1"):
        self.dir = os.path.join(folder, "-Users-me-project")
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, conversation + ".jsonl")
        self.subdir = os.path.join(self.dir, conversation, "subagents")
        self.t = 1_700_000_000_000
        self.n = 0
        open(self.path, "w").close()

    def add(self, entry, step=1000):
        self.t += step
        entry.setdefault("timestamp", iso(self.t))
        with open(self.path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return self.t

    def prompt(self, text="do it", **extra):
        return self.add({"type": "user", "isSidechain": False, "message": {"role": "user", "content": text}, **extra})

    def assistant(self, blocks, model="claude-opus-5-5", usage=None):
        return self.add({"type": "assistant", "isSidechain": False, "requestedModel": model,
                         "message": {"model": model, "role": "assistant", "content": blocks,
                                     "usage": usage or {"input_tokens": 10, "cache_read_input_tokens": 1000,
                                                        "cache_creation_input_tokens": 90, "output_tokens": 5}}})

    def tool(self, name, inp=None):
        self.n += 1
        tid = "toolu_%d" % self.n
        self.assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp or {}}])
        return tid

    def result(self, tid, text="ok", error=False, meta=None):
        entry = {"type": "user", "isSidechain": False,
                 "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": error}]}}
        if meta is not None:
            entry["toolUseResult"] = meta
        return self.add(entry)

    def subagent(self, agent_id, tool_id, finished, steps=()):
        os.makedirs(self.subdir, exist_ok=True)
        with open(os.path.join(self.subdir, "agent-%s.meta.json" % agent_id), "w") as f:
            json.dump({"agentType": "Explore", "description": "meta title", "toolUseId": tool_id, "finished": finished}, f)
        with open(os.path.join(self.subdir, "agent-%s.jsonl" % agent_id), "w") as f:
            for i, blocks in enumerate(steps):
                f.write(json.dumps({"type": "assistant", "isSidechain": True, "agentId": agent_id, "timestamp": iso(self.t + i),
                                    "message": {"content": blocks}}) + "\n")


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tr = Transcript(self.tmp.name)

    def test_only_entries_since_the_last_real_prompt_count(self):
        tr = self.tr
        tr.prompt("old turn")
        tr.tool("Bash", {"command": "ls"})
        start = tr.prompt("new turn")
        # Neither of these starts a turn: a tool result and a task notification.
        tr.add({"type": "user", "isMeta": True, "message": {"content": "caveat"}})
        tr.add({"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": "<task-notification>\nx"}})
        for _ in range(4):
            tr.result(tr.tool("Read", {"file_path": "/a/b.py"}))
        tr.result(tr.tool("Bash", {"command": "make"}))
        tr.result(tr.tool("Bash", {"command": "make test"}), "boom", error=True)
        tr.tool("Grep", {"pattern": "x"})
        out = rt.transcript_timeline(tr.path)
        self.assertEqual(start, out["turn"]["started_ms"])
        self.assertTrue(out["turn"]["working"])
        self.assertEqual({"read": 4, "search": 1, "command": 2, "edit": 0, "web": 0, "agent": 0, "other": 0}, out["tools"]["counts"])
        self.assertEqual(1, out["tools"]["failed"])
        self.assertEqual("Read 4 files, ran 2 commands, 1 failed", out["tools"]["summary"])

    def test_turn_end_marks_not_working_and_since_ms_overrides(self):
        tr = self.tr
        tr.prompt()
        tr.result(tr.tool("Edit", {"file_path": "x"}))
        mid = tr.t
        tr.result(tr.tool("WebFetch", {"url": "https://a.b"}))
        tr.add({"type": "system", "subtype": "turn_duration", "durationMs": 5})
        out = rt.transcript_timeline(tr.path)
        self.assertFalse(out["turn"]["working"])
        self.assertEqual(1, out["tools"]["counts"]["edit"])
        later = rt.transcript_timeline(tr.path, since_ms=mid + 1)
        self.assertEqual(mid + 1, later["turn"]["started_ms"])
        self.assertEqual(0, later["tools"]["counts"]["edit"])
        self.assertEqual(1, later["tools"]["counts"]["web"])

    def test_summary_ranking_and_wording(self):
        self.assertEqual("Ran 2 commands, made 2 edits", rt.tools_summary({"read": 2, "command": 2, "edit": 2}))
        self.assertEqual("Started 1 agent, read 1 file", rt.tools_summary({"read": 1, "agent": 1}))
        self.assertEqual("", rt.tools_summary({}))
        self.assertEqual("Used 3 other tools", rt.tools_summary({"other": 3}))

    def test_thought_skips_empty_thinking_and_extracts_heading(self):
        tr = self.tr
        tr.prompt()
        tr.assistant([{"type": "thinking", "thinking": "**Planning the fix**\nFirst I read " + "x" * 600, "signature": "s"}])
        tr.assistant([{"type": "thinking", "thinking": "", "signature": "s"}])
        out = rt.transcript_timeline(tr.path)
        self.assertEqual("Planning the fix", out["thought"]["heading"])
        self.assertEqual(400, len(out["thought"]["text"]))
        self.assertEqual("thinking", out["thought"]["source"])

    def test_no_thought_is_null(self):
        self.tr.prompt()
        self.tr.assistant([{"type": "thinking", "thinking": "", "signature": "s"}])
        self.assertIsNone(rt.transcript_timeline(self.tr.path)["thought"])

    def test_subagents_sync_async_running_and_failed(self):
        tr = self.tr
        tr.prompt()
        sync = tr.tool("Agent", {"description": "Find the bug", "subagent_type": "Explore"})
        tr.result(sync, "Found it in foo.py\nmore")
        running = tr.tool("Task", {"description": "Map the API", "subagent_type": "general-purpose"})
        tr.result(running, "launched", meta={"status": "async_launched", "agentId": "a1"})
        tr.subagent("a1", running, False, steps=[[{"type": "tool_use", "name": "Grep", "input": {"pattern": "route"}}]])
        finished = tr.tool("Agent", {"description": "Write tests"})
        tr.result(finished, "launched", meta={"status": "async_launched", "agentId": "a2"})
        tr.subagent("a2", finished, True, steps=[[{"type": "text", "text": "All 12 tests pass\nbye"}]])
        broken = tr.tool("Agent", {"description": "Break things"})
        tr.result(broken, "agent crashed", error=True)
        subs = {s["title"]: s for s in rt.transcript_timeline(tr.path)["subagents"]}
        self.assertEqual(("done", "Found it in foo.py", "Explore"), (subs["Find the bug"]["status"], subs["Find the bug"]["line"], subs["Find the bug"]["type"]))
        self.assertIsNotNone(subs["Find the bug"]["ended_ms"])
        self.assertEqual(("running", "Search for route", "agent-a1", None),
                         (subs["Map the API"]["status"], subs["Map the API"]["line"], subs["Map the API"]["id"], subs["Map the API"]["ended_ms"]))
        self.assertEqual(("done", "All 12 tests pass"), (subs["Write tests"]["status"], subs["Write tests"]["line"]))
        self.assertEqual("failed", subs["Break things"]["status"])
        self.assertEqual(4, rt.transcript_timeline(tr.path)["tools"]["counts"]["agent"])

    def test_context_from_latest_main_usage_and_1m_models(self):
        tr = self.tr
        tr.prompt()
        tr.assistant([{"type": "text", "text": "hi"}], usage={"input_tokens": 1, "cache_read_input_tokens": 100_000, "cache_creation_input_tokens": 2_000, "output_tokens": 50})
        tr.add({"type": "assistant", "isSidechain": True, "message": {"content": [], "usage": {"input_tokens": 9}}})
        self.assertEqual({"tokens": 102_001, "max": 200_000}, rt.transcript_timeline(tr.path)["context"])
        tr.assistant([{"type": "text", "text": "hi"}], model="claude-opus-5-5[1m]")
        self.assertEqual(1_000_000, rt.transcript_timeline(tr.path)["context"]["max"])
        tr.add({"type": "system", "subtype": "compact_boundary"})
        self.assertIsNone(rt.transcript_timeline(tr.path)["context"]["tokens"])

    def test_title_from_tail_and_cached_full_scan(self):
        tr = self.tr
        tr.add({"type": "ai-title", "aiTitle": "Old name", "sessionId": "x"})
        tr.add({"type": "ai-title", "aiTitle": "Fix the login flow", "sessionId": "x"})
        tr.prompt()
        self.assertEqual("Fix the login flow", rt.transcript_timeline(tr.path)["title"])
        # Push the title out of the 512KB tail: the title scan still finds it.
        with open(tr.path, "a") as f:
            for _ in range(700):
                f.write(json.dumps({"type": "user", "message": {"content": "y" * 1000}}) + "\n")
        self.assertIsNone(rt.transcript_timeline(tr.path)["title"])
        cache = os.path.join(self.tmp.name, "titles.json")
        self.assertEqual("Fix the login flow", rt.transcript_title(tr.path, cache))
        # A cache hit doesn't reread: corrupt nothing, just prove the stamp is used.
        with open(cache) as f:
            data = json.load(f)
        data[tr.path]["title"] = "From cache"
        with open(cache, "w") as f:
            json.dump(data, f)
        self.assertEqual("From cache", rt.transcript_title(tr.path, cache))
        tr.add({"type": "ai-title", "aiTitle": "Renamed", "sessionId": "x"})
        self.assertEqual("Renamed", rt.transcript_title(tr.path, cache))

    def test_corrupt_lines_and_missing_files_are_tolerated(self):
        tr = self.tr
        tr.prompt()
        with open(tr.path, "a") as f:
            f.write("{not json\n[1,2]\n")
        tr.tool("Read", {"file_path": "x"})
        self.assertEqual(1, rt.transcript_timeline(tr.path)["tools"]["counts"]["read"])
        self.assertIsNone(rt.transcript_title(os.path.join(self.tmp.name, "nope.jsonl")))

    def test_find_transcript_rejects_glob_injection(self):
        self.assertEqual(self.tr.path, rt.find_transcript("conv-1", self.tmp.name))
        for bad in ("*", "../conv-1", "", None, "conv-1/../../x"):
            self.assertIsNone(rt.find_transcript(bad, self.tmp.name))

    def test_big_transcript_is_fast_and_bounded(self):
        tr = self.tr
        blob = "z" * 4000
        with open(tr.path, "a") as f:
            for i in range(5000):  # ~20MB of history before the turn
                f.write(json.dumps({"type": "user", "message": {"content": blob}, "timestamp": iso(tr.t)}) + "\n")
        tr.prompt()
        for _ in range(150):
            tr.result(tr.tool("Read", {"file_path": "a"}), "r" * 4000)
        self.assertGreater(os.path.getsize(tr.path), 15_000_000)
        began = time.perf_counter()
        out = rt.transcript_timeline(tr.path)
        took = time.perf_counter() - began
        self.assertLess(took, 0.15, "timeline took %.0fms" % (took * 1000))
        # The turn is longer than the 512KB tail: it's cut, not read in full.
        self.assertLess(out["tools"]["counts"]["read"], 150)
        self.assertGreater(out["tools"]["counts"]["read"], 50)
        self.assertTrue(out["turn"]["partial"])
        self.assertFalse(rt.transcript_timeline(Transcript(self.tmp.name, "small").path)["turn"]["partial"])


if __name__ == "__main__":
    unittest.main()
