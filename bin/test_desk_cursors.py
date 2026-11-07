"""The chat cursors file under concurrent readers: every agent sees each record exactly once."""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
loader = importlib.machinery.SourceFileLoader('desk_team_cursors', os.path.join(os.path.dirname(__file__), 'team'))
spec = importlib.util.spec_from_loader(loader.name, loader)
team = importlib.util.module_from_spec(spec)
loader.exec_module(team)


class CursorRace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(team, 'CHAT', self.tmp.name); p.start(); self.addCleanup(p.stop)

    def test_concurrent_readers_never_lose_or_repeat_a_record(self):
        readers, rounds, appends = [f't{i}' for i in range(6)], 60, 120
        seen = {a: [] for a in readers}
        errors = []

        def read(address):
            try:
                for _ in range(rounds):
                    seen[address] += [r['n'] for r in team.unread('desk', address)]
            except Exception as e:  # a crash here is the defect
                errors.append(repr(e))

        def write():
            for n in range(appends):
                team.chat_append('desk', {'from': 'kabeer', 'kind': 'say', 'text': 'x', 'n': n})

        threads = [threading.Thread(target=read, args=(a,)) for a in readers] + [threading.Thread(target=write)]
        for t in threads: t.start()
        for t in threads: t.join()
        for a in readers:
            seen[a] += [r['n'] for r in team.unread('desk', a)]
        self.assertEqual([], errors)
        for a in readers:
            self.assertEqual(list(range(appends)), seen[a], a)
        with open(team.cursors_file('desk')) as f:
            self.assertEqual(set(readers), set(json.load(f)))
        self.assertEqual([], [n for n in os.listdir(self.tmp.name) if n.endswith('.tmp') or '.tmp' in n])


if __name__ == '__main__':
    unittest.main()
