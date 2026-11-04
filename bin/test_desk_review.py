import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import desk_review


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        for args in (("init",), ("config", "user.email", "test@example.com"), ("config", "user.name", "Test")):
            subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)
        Path(self.root, "base.txt").write_text("base\n")
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-b", "feature"], cwd=self.root, check=True, capture_output=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_working_includes_untracked_and_counts(self):
        Path(self.root, "base.txt").write_text("changed\n")
        Path(self.root, "new file.txt").write_text("hello\n")
        out = desk_review.review(self.root, "working")
        paths = {f["path"]: f for f in out["files"]}
        self.assertIn("new file.txt", paths)
        self.assertIn("+hello", out["diff"])
        self.assertGreaterEqual(paths["base.txt"]["added"], 1)

    def test_space_name_can_be_selected(self):
        name = "a file with spaces.txt"
        Path(self.root, name).write_text("hello\n")
        out = desk_review.review(self.root, "working", name)
        self.assertEqual([item["path"] for item in out["files"]], [name])
        self.assertIn("+hello", out["diff"])

    def test_selected_tracked_file_is_not_repeated_as_untracked(self):
        Path(self.root, "base.txt").write_text("changed\n")
        out = desk_review.review(self.root, "working", "base.txt")
        self.assertEqual(out["diff"].count("diff --git"), 1)

    def test_symlink_untracked_file_is_not_followed(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as secret:
            secret.write("do not read\n")
            target = secret.name
        self.addCleanup(lambda: os.path.exists(target) and os.unlink(target))
        os.symlink(target, Path(self.root, "link.txt"))
        out = desk_review.review(self.root, "working")
        self.assertNotIn("do not read", out["diff"])

    def test_rejects_escape_and_unchanged_path(self):
        Path(self.root, "base.txt").write_text("changed\n")
        with self.assertRaises(ValueError): desk_review.review(self.root, "working", "../x")
        with self.assertRaises(ValueError): desk_review.review(self.root, "working", "other.txt")

    def test_binary_is_described(self):
        Path(self.root, "blob.bin").write_bytes(b"x\0y")
        out = desk_review.review(self.root, "working")
        item = next(f for f in out["files"] if f["path"] == "blob.bin")
        self.assertTrue(item["binary"])
        self.assertIn("Binary untracked file", out["diff"])

    def test_staged_and_branch_modes(self):
        Path(self.root, "base.txt").write_text("changed\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.root, check=True)
        self.assertIn("+changed", desk_review.review(self.root, "staged")["diff"])
        subprocess.run(["git", "commit", "-m", "changed"], cwd=self.root, check=True, capture_output=True)
        self.assertIn("+changed", desk_review.review(self.root, "branch")["diff"])

    def test_branch_uses_main_not_own_tracking_branch(self):
        Path(self.root, "base.txt").write_text("feature\n")
        subprocess.run(["git", "commit", "-am", "feature"], cwd=self.root, check=True, capture_output=True)
        # A self remote is enough to create origin/feature at the same commit as HEAD.
        subprocess.run(["git", "remote", "add", "origin", self.root], cwd=self.root, check=True)
        subprocess.run(["git", "fetch", "origin", "feature:refs/remotes/origin/feature"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "branch", "--set-upstream-to=origin/feature", "feature"], cwd=self.root, check=True, capture_output=True)
        out = desk_review.review(self.root, "branch")
        self.assertIn("+feature", out["diff"])

    def test_invalid_repo_is_clear(self):
        with tempfile.TemporaryDirectory() as bad:
            with self.assertRaisesRegex(ValueError, "Not a git repository"):
                desk_review.review(bad, "working")


class TurnReviewTests(unittest.TestCase):
    def setUp(self):
        ReviewTests.setUp(self)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout

    def test_turn_before_snapshot_is_a_clear_error(self):
        with self.assertRaisesRegex(ValueError, "No turn snapshot"):
            desk_review.review(self.root, "turn")

    def test_snapshot_never_touches_index_or_working_tree(self):
        Path(self.root, "base.txt").write_text("edited before the turn\n")
        Path(self.root, "staged.txt").write_text("staged\n")
        self.git("add", "staged.txt")
        Path(self.root, "untracked.txt").write_text("loose\n")
        index_before = Path(self.root, ".git", "index").read_bytes()
        status_before = self.git("status", "--porcelain")
        out = desk_review.snapshot_turn(self.root)
        self.assertEqual(index_before, Path(self.root, ".git", "index").read_bytes())
        self.assertEqual(status_before, self.git("status", "--porcelain"))
        self.assertEqual("tree", self.git("cat-file", "-t", desk_review.TURN_REF).strip())
        self.assertEqual(out["tree"], self.git("rev-parse", desk_review.TURN_REF).strip())
        self.assertFalse([p for p in os.listdir(Path(self.root, ".git")) if p.startswith("desk-index-")])

    def test_turn_shows_only_this_turns_changes_including_untracked(self):
        Path(self.root, "base.txt").write_text("edited before the turn\n")
        Path(self.root, "old-untracked.txt").write_text("was here\n")
        desk_review.snapshot_turn(self.root)
        Path(self.root, "base.txt").write_text("edited before the turn\nand during it\n")
        Path(self.root, "new.txt").write_text("brand new\n")
        Path(self.root, "blob.bin").write_bytes(b"x\0y")
        out = desk_review.review(self.root, "turn")
        files = {f["path"]: f for f in out["files"]}
        self.assertEqual({"base.txt", "new.txt", "blob.bin"}, set(files))
        self.assertEqual("added", files["new.txt"]["status"])
        self.assertEqual((1, 0), (files["base.txt"]["added"], files["base.txt"]["removed"]))
        self.assertTrue(files["blob.bin"]["binary"])
        self.assertIn("+and during it", out["diff"])
        self.assertNotIn("+edited before the turn", out["diff"])
        self.assertNotIn("old-untracked", out["diff"])
        self.assertTrue(out["binary"])

    def test_turn_deletion_path_filter_and_escape(self):
        desk_review.snapshot_turn(self.root)
        os.unlink(Path(self.root, "base.txt"))
        Path(self.root, "other.txt").write_text("x\n")
        out = desk_review.review(self.root, "turn", "base.txt")
        self.assertEqual("deleted", out["files"][0]["status"])
        self.assertNotIn("other.txt", out["diff"])
        with self.assertRaises(ValueError): desk_review.review(self.root, "turn", "../x")
        with self.assertRaises(ValueError): desk_review.review(self.root, "turn", "unchanged.txt")

    def test_turn_diff_is_capped(self):
        desk_review.snapshot_turn(self.root)
        Path(self.root, "big.txt").write_text("line\n" * 60_000)
        out = desk_review.review(self.root, "turn")
        self.assertTrue(out["truncated"])
        self.assertLess(len(out["diff"].encode()), desk_review.MAX_DIFF + 100)

    def test_linked_worktrees_keep_their_own_turn_base(self):
        other = os.path.join(self.tmp.name, "..", os.path.basename(self.tmp.name) + "-wt")
        self.git("worktree", "add", "-b", "wt", other)
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", other]))
        desk_review.snapshot_turn(self.root)
        with self.assertRaisesRegex(ValueError, "No turn snapshot"):
            desk_review.review(other, "turn")
        desk_review.snapshot_turn(other)
        Path(other, "base.txt").write_text("in the worktree\n")
        self.assertEqual(["base.txt"], [f["path"] for f in desk_review.review(other, "turn")["files"]])
        self.assertEqual([], desk_review.review(self.root, "turn")["files"])


if __name__ == "__main__":
    unittest.main()
