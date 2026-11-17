"""Tests of what a TCR checkpoint refuses to commit: files named like secrets, lines that are high-confidence secrets,
and files too large for a hosting service, run against real git repositories in temporary directories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from collections.abc import Callable
from pathlib import Path

from paths import ROOT
import checkpoint
from checkpoint_repository import git, isolate_git, make_dir, put, remove, restore_git
from discovery import ConfigurationError
from tcr_settings import read_settings
from codex_hook import read

AWS_KEY = "AKIA" + "A" * 16
PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY-----"
GITHUB_TOKEN = "ghp_" + "a" * 36
SLACK_TOKEN = "xoxb-" + "1234-abcd"
STRIPE_KEY = "sk_live_" + "a" * 24
ANTHROPIC_KEY = "sk-ant-" + "api03-abcdef"
GOOGLE_KEY = "AIza" + "a" * 35
CONTENT_SAMPLES = {
    "AWS access key": AWS_KEY, "private key": PRIVATE_KEY, "GitHub token": GITHUB_TOKEN, "Slack token": SLACK_TOKEN,
    "Stripe live key": STRIPE_KEY, "Anthropic key": ANTHROPIC_KEY, "Google API key": GOOGLE_KEY,
}
REFUSED_NAMES = (".env", ".env.local", ".env.production", "server.pem", "a.key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_rsa.bak", "keys/id_ed25519",
                 ".npmrc", ".netrc", "credentials", "credentials.json", "credentials.yml", "credentials.yaml", "bundle.p12", "bundle.pfx", "config/.env", "keys/server.pem")
ALLOWED_NAMES = (".env.example", ".env.sample", ".env.template", "id_rsa.pub", "environment.py", "keyboard.txt", "pemberton.txt", "notes.txt",
                 "id_utils.py", "src/id_utils.py", "id_custom", "credentials_test.py", "src/credentials_helper.py")
SMALL_FILES = 1000
GENEROUS_SECONDS_FOR_SMALL_FILES = 2.0


def timed(action: Callable[[], object]) -> float:
    """How many seconds the action took."""
    started = time.perf_counter()
    action()
    elapsed = time.perf_counter() - started
    assert elapsed >= 0, f"the clock ran backwards by {-elapsed} seconds"
    assert callable(action), f"{action!r} is not something to run"
    return elapsed


class CheckpointGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        git(self.repo, ["init", "-q", "-b", "main"])
        put(self.repo / "a.txt", "base\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "start"])
        assert git(self.repo, ["status", "--porcelain"]) == "", f"{self.repo} is not clean after setup"
        assert git(self.repo, ["rev-list", "--count", "HEAD"]) == "1", f"{self.repo} does not hold exactly the start commit"

    def stage(self, name: str, text: str = "x\n") -> None:
        path = self.repo / name
        if not path.parent.exists():
            make_dir(path.parent)
        put(path, text)
        git(self.repo, ["add", "-A"])
        assert name in git(self.repo, ["diff", "--cached", "--name-only", "-z"]).split("\0"), f"{name} was not staged in {self.repo}"
        assert path.is_file(), f"{path} is no file after it was written"

    def refusals(self, allow: tuple[str, ...] = ()) -> list[str]:
        found = [refusal.text() for refusal in checkpoint.refusals(self.repo, allow)]
        assert all(isinstance(text, str) and text for text in found), f"a refusal came back as no text: {found}"
        assert len(set(found)) == len(found), f"a refusal came back twice: {found}"
        return found

    def test_files_named_like_secrets_are_refused_by_their_name(self) -> None:
        for name in REFUSED_NAMES:
            with self.subTest(name=name):
                self.stage(name)
                self.assertEqual(self.refusals(), [f"{name} (name pattern)"])
                git(self.repo, ["reset", "-q"])
                remove(self.repo / name)

    def test_files_named_like_templates_or_public_keys_are_not_refused(self) -> None:
        for name in ALLOWED_NAMES:
            with self.subTest(name=name):
                self.stage(name)
                self.assertEqual(self.refusals(), [])
                git(self.repo, ["reset", "-q"])
                remove(self.repo / name)

    def test_each_high_confidence_secret_is_refused_with_its_file_and_line(self) -> None:
        for rule, sample in CONTENT_SAMPLES.items():
            with self.subTest(rule=rule):
                self.stage("src/a.py", f"one = 1\ntwo = 2\nvalue = '{sample}'\n")
                self.assertEqual(self.refusals(), [f"src/a.py:3 ({rule})"])
                git(self.repo, ["reset", "-q"])
                remove(self.repo / "src" / "a.py")

    def test_added_lines_that_look_like_diff_headers_do_not_derail_the_line_numbers(self) -> None:
        self.stage("notes.md", f"++ one\n+++ two\n--- three\nvalue = '{AWS_KEY}'\n")
        self.assertEqual(self.refusals(), [f"notes.md:4 (AWS access key)"])

    def test_a_secret_after_a_changed_line_is_named_by_its_new_line_number(self) -> None:
        put(self.repo / "a.txt", "one\ntwo\nthree\nfour\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "four lines"])
        self.stage("a.txt", f"one\nTWO\nthree\nfour\nvalue = '{AWS_KEY}'\n")
        self.assertEqual(self.refusals(), [f"a.txt:5 (AWS access key)"])

    def test_a_generic_key_assignment_is_not_refused(self) -> None:
        self.stage("src/a.py", 'api_key = "x"\nsecret = "hunter2"\npassword = "abc123"\n')
        self.assertEqual(self.refusals(), [])

    def test_a_secret_on_a_line_the_edit_removed_is_not_refused(self) -> None:
        put(self.repo / "old.py", f"value = '{AWS_KEY}'\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "an old secret"])
        self.stage("old.py", "value = 'gone'\n")
        self.assertEqual(self.refusals(), [])

    def test_a_file_over_the_size_cap_is_refused_and_one_at_the_cap_is_not(self) -> None:
        self.stage("at_cap.bin", "")
        with (self.repo / "at_cap.bin").open("r+b") as handle:
            handle.truncate(checkpoint.MAX_STAGED_BYTES)
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(), [])
        with (self.repo / "at_cap.bin").open("r+b") as handle:
            handle.truncate(checkpoint.MAX_STAGED_BYTES + 1)
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(), ["at_cap.bin (larger than 50 MiB)"])

    def test_the_allowlist_skips_the_name_and_content_rules_but_not_the_size_cap(self) -> None:
        self.stage(".env", f"value = '{AWS_KEY}'\n")
        self.stage("config/.env.local")
        self.stage("big.key", "")
        with (self.repo / "big.key").open("r+b") as handle:
            handle.truncate(checkpoint.MAX_STAGED_BYTES + 1)
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(allow=(".env", "config/*", "big.key")), ["big.key (larger than 50 MiB)"])

    def test_an_allowlist_name_without_a_directory_matches_only_that_name_at_the_root(self) -> None:
        self.stage(".env")
        self.stage("deploy/prod/.env")
        self.assertEqual(self.refusals(allow=(".env",)), ["deploy/prod/.env (name pattern)"])

    def test_an_allowlist_entry_that_starts_with_two_stars_matches_the_name_in_any_directory(self) -> None:
        self.stage(".env")
        self.stage("deploy/prod/.env")
        self.assertEqual(self.refusals(allow=("**/.env",)), [])

    def test_a_star_in_an_allowlist_entry_does_not_cross_a_directory(self) -> None:
        self.stage("config/.env.local")
        self.stage("config/sub/.env")
        self.assertEqual(self.refusals(allow=("config/*",)), ["config/sub/.env (name pattern)"])

    def test_an_allowlist_entry_names_a_path_with_a_space(self) -> None:
        self.stage("sp ace/x.py", f"value = '{AWS_KEY}'\n")
        self.assertEqual(self.refusals(), [f"sp ace/x.py:1 (AWS access key)"])
        self.assertEqual(self.refusals(allow=("sp ace/x.py",)), [])

    def test_a_secret_inside_a_binary_file_is_refused(self) -> None:
        self.stage("a.dat", f"\0\0{AWS_KEY}\0")
        self.assertEqual(self.refusals(), ["a.dat:1 (AWS access key)"])

    def test_an_allowlist_entry_that_is_empty_or_only_wildcards_is_an_error_that_names_the_field(self) -> None:
        for entry in ("", "*", "**", "**/*", "  ", "**/?*", "?", "[]", "*/?[]"):
            with self.subTest(entry=entry), self.assertRaises(ConfigurationError) as caught:
                checkpoint.checkpoint(self.repo, allow=(entry,))
            self.assertIn("tcr.allow", str(caught.exception))
            self.assertIn("only wildcards", str(caught.exception))

    def test_the_hook_and_the_checkpoint_give_the_same_message_for_a_bad_allowlist(self) -> None:
        with self.assertRaises(ConfigurationError) as from_settings:
            read_settings({"tcr": {"allow": [""]}})
        with self.assertRaises(ConfigurationError) as from_checkpoint:
            checkpoint.checkpoint(self.repo, allow=("",))
        self.assertEqual(str(from_settings.exception), str(from_checkpoint.exception))

    def test_an_unknown_field_under_tcr_is_an_error_that_names_it(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            read_settings({"tcr": {"alow": []}})
        self.assertIn("alow", str(caught.exception))

    def test_a_checkpoint_that_would_commit_a_secret_commits_and_reverts_nothing_and_leaves_the_work_tree_and_unstaged_files(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        put(self.repo / ".env", "TOKEN=1\n")
        head = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.Refused) as caught:
            checkpoint.checkpoint(self.repo)
        self.assertEqual([refusal.text() for refusal in caught.exception.refusals], [".env (name pattern)"])
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), head)
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertEqual(read(self.repo / "a.txt"), "edited\n")
        self.assertEqual(read(self.repo / ".env"), "TOKEN=1\n")
        self.assertEqual(sorted(line.strip() for line in git(self.repo, ["status", "--porcelain"]).splitlines()), ["?? .env", "M a.txt"])

    def test_a_refused_checkpoint_names_every_file_and_rule_in_its_error(self) -> None:
        put(self.repo / ".env", "TOKEN=1\n")
        put(self.repo / "src.py", f"value = '{AWS_KEY}'\n")
        with self.assertRaises(checkpoint.Refused) as caught:
            checkpoint.checkpoint(self.repo)
        self.assertIn(".env (name pattern)", str(caught.exception))
        self.assertIn("src.py:1 (AWS access key)", str(caught.exception))

    def test_a_checkpoint_commits_an_allowlisted_env_file_and_a_template(self) -> None:
        put(self.repo / ".env", "TOKEN=1\n")
        put(self.repo / ".env.example", "TOKEN=\n")
        sha = checkpoint.checkpoint(self.repo, allow=(".env",))
        self.assertEqual(sha, git(self.repo, ["rev-parse", "HEAD"]))
        self.assertEqual(sorted(git(self.repo, ["show", "--name-only", "--format=", "HEAD"]).split()), [".env", ".env.example"])

    def test_a_checkpoint_commits_a_generic_key_assignment(self) -> None:
        put(self.repo / "a.py", 'api_key = "x"\n')
        self.assertIsNotNone(checkpoint.checkpoint(self.repo))

    def test_the_guard_reads_a_thousand_small_files_well_within_a_generous_bound(self) -> None:
        for index in range(SMALL_FILES):
            put(self.repo / f"f{index:04}.txt", "line one\nline two\nline three\n")
        git(self.repo, ["add", "-A"])
        elapsed = timed(lambda: self.assertEqual(checkpoint.refusals(self.repo, ()), []))
        self.assertLess(elapsed, GENEROUS_SECONDS_FOR_SMALL_FILES, f"screening {SMALL_FILES} staged files took {elapsed:.3f} s")
        self.addCleanup(print, f"\nscreening {SMALL_FILES} staged files took {elapsed * 1000:.0f} ms", flush=True)

    def test_the_module_ships_in_the_package(self) -> None:
        self.assertIn("engine", json.loads(read(ROOT / "package.json"))["files"])


if __name__ == "__main__":
    unittest.main()
