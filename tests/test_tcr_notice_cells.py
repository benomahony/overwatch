"""Tests that every notice TCR sends after a revert attempt names exactly the recovery paths that exist: the saved ref, its staged copy `<ref>^2` only when the index held a version the tree did not, the submodule note only when submodules were skipped, for each state of the reset, the saved ref and the submodules.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import itertools
import subprocess
import unittest
import unittest.mock
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from pathlib import Path

import paths
import checkpoint
import tcr
import tcr_texts
import test_tcr_revert_faults as faults
from checkpoint_repository import git, make_dir, put, remove_fixture_file, set_mode
from codex_hook import write
from records import First, State
from tcr_hardening_case import PROJECT_FILE, HardeningCase
from notice_cover import names_after, pairwise
from hostile_builders import SAVED_REF, logs_of, report_with
from test_tcr import EDITING

SUBMODULE = "vendor/lib"
RESTORED = ["a.txt", "b.txt"]
LEFT_NONE, LEFT_SOME, LEFT_ALL, LEFT_LATE = "no file left", "one file git could not restore", "every file git could not restore", "a file that changed after the listing"
LEFT_FILES = {LEFT_NONE: [], LEFT_SOME: ["a.txt"], LEFT_ALL: ["a.txt", "b.txt"], LEFT_LATE: ["late.txt"]}
RESET_REACHED, RESET_REFUSED, GIT_COULD_NOT_SAY = "the reset happened", "the reset was refused", "git could not say whether the files changed"
STATES = (RESET_REACHED, RESET_REFUSED, GIT_COULD_NOT_SAY)
SAVED_REFS = (None, SAVED_REF)
EXPECTED_CELLS = 36
TEXTS_THAT_NAME_THE_STAGED_COPY = 3
EVERY_FILE, SOME_FILES, NO_FILE = "every file can be restored", "one file cannot be restored", "no file can be restored"
LISTING_ANSWERS, LISTING_FAILS = "git lists the files after the reset", "git cannot list the files after the reset"
RESETS = ((faults.NORMAL, LISTING_ANSWERS), (faults.REFUSED, LISTING_ANSWERS), (faults.REFUSED, LISTING_FAILS), (faults.TIMES_OUT_BEFORE, LISTING_ANSWERS),
          (faults.TIMES_OUT_BEFORE, LISTING_FAILS), (faults.TIMES_OUT_AFTER, LISTING_ANSWERS), (faults.TIMES_OUT_AFTER, LISTING_FAILS))
SAVE_REF, SAVE_OFF = "the work is saved in a ref", "saveReverted is off"
SKIPPED_SUBMODULE = "vendor/lib"
LATE_FILE = "late.txt"
LOCKED_DIRECTORY = "sub"
LOCKED_FILE = f"{LOCKED_DIRECTORY}/t.txt"
COMMITTED = "committed\n"
MAX_NOTICE_CHARACTERS = 2500

GITLINK_MODE = "160000"
PERSON_VERSION = "person\n"
LATE_NONE, LATE_FRESH, LATE_REWRITE, LATE_DELETE = "no late write", "a fresh file", "a write onto a restored name", "a delete of a restored file"
LATES = (LATE_NONE, LATE_FRESH, LATE_REWRITE, LATE_DELETE)
TREE_AXIS, INDEX_AXIS = 3, 4
MAX_COVER_CELLS = 40


@dataclass(frozen=True)
class Cell:
    state: str
    saved: str | None
    staged: bool
    skipped: bool
    left: str = LEFT_NONE

    def label(self) -> str:
        return f"{self.state}, saved ref {self.saved}, staged copy {self.staged}, submodules skipped {self.skipped}, {self.left}"


def cells() -> list[Cell]:
    """Every state of the reset, the saved ref, the staged copy, the submodules and the files left that can happen: a staged copy is saved with the ref, so none exists without one, and only a revert that reached the reset tells which files are left."""
    return [Cell(state, saved, staged, skipped, left) for state, saved, staged, skipped, left in itertools.product(STATES, SAVED_REFS, (False, True), (False, True), LEFT_FILES)
            if (saved or not staged) and (state == RESET_REACHED or left == LEFT_NONE)]


def notices_of(cell: Cell, many: int = 0) -> dict[str, str]:
    """Each text the agent gets for the cell, built as engine/tcr.py builds it, keyed by what it is. With many, each list of files holds that many names."""
    skipped = [SUBMODULE] if cell.skipped else []
    skipped = [f"{SUBMODULE}{number}" for number in range(many)] if skipped and many else skipped
    restored = [f"file{number}.txt" for number in range(many)] if many else RESTORED
    left_files = {LEFT_NONE: [], LEFT_SOME: restored[:1], LEFT_ALL: restored, LEFT_LATE: [f"late{number}.txt" for number in range(max(many, 1))]} if many else LEFT_FILES
    report = report_with("check")
    if cell.state == RESET_REACHED:
        restoration = tcr_texts.partial_restoration(restored, left_files[cell.left], tcr_texts.Recovery(cell.saved, cell.staged, skipped))
        told = tcr_texts.revert_message([report], {"unrelated": First(False, (), "")}, logs_of(report, "check"), restoration)
    else:
        later = left_files[cell.left]
        told = tcr_texts.unreverted_message(tcr_texts.Recovery(cell.saved, cell.staged, skipped, later))
    return {"notice": told, "reason of the stop": str(checkpoint.RevertIncomplete("the revert failed", cell.saved, cell.staged))}


class RecoveryPathsOfTheNoticesTests(unittest.TestCase):
    def test_the_table_has_a_cell_for_each_state_that_can_happen(self) -> None:
        self.assertEqual(len(cells()), EXPECTED_CELLS, "the table leaves out a state of the reset, the ref, the staged copy or the submodules")
        self.assertEqual(len(set(cells())), len(cells()), "the table has a cell twice")

    def test_each_notice_names_the_recovery_commands_that_apply_and_none_that_do_not(self) -> None:
        for cell in cells():
            for kind, told in notices_of(cell).items():
                with self.subTest(cell=cell.label(), text=kind):
                    ref = cell.saved or SAVED_REF
                    self.assertEqual(f"git checkout {ref} -- ." in told, cell.saved is not None, f"{cell.label()}: the {kind} {'leaves out' if cell.saved else 'names'} the command for the saved ref: {told!r}")
                    self.assertEqual(f"git checkout {ref}^2 -- ." in told, cell.staged, f"{cell.label()}: the {kind} {'leaves out' if cell.staged else 'names'} the command for the staged copy: {told!r}")
                    self.assertEqual("git checkout" in told, cell.saved is not None, f"{cell.label()}: the {kind} gives a checkout command where {'a ref was saved' if cell.saved else 'nothing was saved'}: {told!r}")

    def test_each_notice_names_the_submodules_only_when_they_were_skipped(self) -> None:
        for cell in cells():
            told = notices_of(cell)["notice"]
            with self.subTest(cell=cell.label()):
                self.assertEqual(f"`{SUBMODULE}`" in told, cell.skipped, f"{cell.label()}: the notice {'leaves out' if cell.skipped else 'names'} the submodule: {told!r}")
                self.assertEqual("were not restored and still hold changes" in told, cell.skipped, f"{cell.label()}: the notice {'leaves out' if cell.skipped else 'gives'} the submodule note: {told!r}")

    def test_each_notice_tells_the_files_left_without_a_cause_and_the_work_as_gone_only_when_a_file_came_back_without_a_copy(self) -> None:
        for cell in cells():
            told = notices_of(cell)["notice"]
            came_back = len(RESTORED) - len([name for name in LEFT_FILES[cell.left] if name in RESTORED])
            with self.subTest(cell=cell.label()):
                self.assertEqual("Still changed:" in told, cell.left in (LEFT_SOME, LEFT_ALL), f"{cell.label()}: the notice {'leaves out' if cell.left in (LEFT_SOME, LEFT_ALL) else 'gives'} the files still changed: {told!r}")
                self.assertNotIn("because git could not", told, f"{cell.label()}: the notice names a cause: {told!r}")
                self.assertEqual("Changed after TCR listed the files" in told, cell.left == LEFT_LATE, f"{cell.label()}: the notice {'leaves out' if cell.left == LEFT_LATE else 'gives'} the files that changed after the listing: {told!r}")
                self.assertEqual("No file was restored." in told, cell.state == RESET_REACHED and came_back == 0, f"{cell.label()}: the notice misstates whether a file came back: {told!r}")
                says_gone = "The discarded work is gone" in told
                self.assertEqual(says_gone, cell.state == RESET_REACHED and cell.saved is None and came_back > 0, f"{cell.label()}: the notice {'says' if says_gone else 'does not say'} that the work is gone where {came_back} files came back and no copy was saved: {told!r}")
                self.assertEqual("No copy was saved" in told, cell.saved is None and not says_gone, f"{cell.label()}: the notice misstates that no copy was saved: {told!r}")

    def test_a_notice_names_at_most_the_limit_of_files_in_every_cell_and_says_how_many_more(self) -> None:
        many = 5000
        for cell in cells():
            for kind, told in notices_of(cell, many).items():
                with self.subTest(cell=cell.label(), text=kind):
                    self.assertLess(len(told), MAX_NOTICE_CHARACTERS, f"{cell.label()}: the {kind} of {many} files is {len(told)} characters long")
                    self.assertLessEqual(told.count(".txt"), checkpoint.MESSAGE_FILES * 3, f"{cell.label()}: the {kind} names more files than the limit allows")

    def test_the_sentence_on_the_failing_checks_names_each_quoted_and_where_each_output_is(self) -> None:
        reports = [report_with("first"), report_with("second")]
        logs = {key: path for report in reports for key, path in logs_of(report, report.name).items()}
        one = tcr_texts.failing_check(reports[:1], logs)
        many = tcr_texts.failing_check(reports, logs)
        self.assertEqual(one, " The failing check is `first`; its full output is in `/logs/first`.", "one failing check is not named quoted with its log")
        self.assertEqual(many, " The failing checks are `first`, `second`; their full output is in `/logs/first`, `/logs/second`.", "the failing checks are not all named quoted with their logs")

    def test_a_staged_copy_without_a_saved_ref_is_refused_by_every_text_that_names_it(self) -> None:
        builders: dict[str, Callable[[], object]] = {
            "restoration": lambda: tcr_texts.restoration(RESTORED, None, [], True),
            "unreverted_message": lambda: tcr_texts.unreverted_message(tcr_texts.Recovery(None, True, [])),
            "RevertIncomplete": lambda: checkpoint.RevertIncomplete("the revert failed", None, True),
        }
        self.assertEqual(len(builders), TEXTS_THAT_NAME_THE_STAGED_COPY, "a text that names the staged copy was left out of the refusal")
        for name, build in builders.items():
            with self.subTest(text=name):
                with self.assertRaises(AssertionError, msg=f"{name} accepted a staged copy that no ref holds"):
                    build()


class ToldTests(unittest.TestCase):
    def test_every_notice_reaches_the_agents_context_before_what_was_there_and_the_overwatch_record_lists_them(self) -> None:
        """tcr.told puts each notice in additionalContext in order and before the earlier context, keeps the status line the output has, and lists the notices where the output records them."""
        notices = ("first notice", "second notice")
        taken = tcr.TcrStep(State(), notices, "status")
        bare = tcr.told({}, "PostToolUse", taken)
        self.assertEqual(bare["hookSpecificOutput"]["additionalContext"], "\n\n".join(notices), "the notices are not in the context in order")
        self.assertEqual(bare["systemMessage"], "status", "the status line was not set")
        earlier = tcr.told({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "earlier"}, "systemMessage": "kept", "overwatch": {"kind": "x"}}, "PostToolUse", taken)
        self.assertEqual(earlier["hookSpecificOutput"]["additionalContext"], "\n\n".join((*notices, "earlier")), "the notices do not come before the earlier context")
        self.assertEqual(earlier["systemMessage"], "kept", "the status line the output had was replaced")
        self.assertEqual(earlier["overwatch"], {"kind": "x", "notices": list(notices)}, "the overwatch record does not list the notices")

    def test_an_output_is_left_as_it_was_when_nothing_is_told(self) -> None:
        output = {"systemMessage": "kept"}
        self.assertEqual(tcr.told(output, "PostToolUse", tcr.TcrStep(State())), {"systemMessage": "kept"}, "an output with nothing to tell was changed")
        self.assertNotIn("hookSpecificOutput", output, "a context was added where nothing is told")


class NamedInTests(unittest.TestCase):
    def test_a_template_with_no_place_for_the_names_is_refused_and_one_with_another_field_fails_to_format(self) -> None:
        with self.assertRaises(AssertionError, msg="a template with no place for the names was accepted"):
            tcr_texts.named_in(["a"], "no place", "files")
        with self.assertRaises(KeyError, msg="a template with a field besides the names was formatted"):
            tcr_texts.named_in(["a"], "{names} {other}", "files")
        self.assertEqual(tcr_texts.named_in([], "{names}", "files"), "", "no name gave a sentence")


class StepStateTests(unittest.TestCase):
    def test_an_unsettled_edit_changes_only_the_fingerprints_and_keeps_the_baseline(self) -> None:
        baseline = {"check": First(False, (), "")}
        current = State(held=("check",), fingerprint="checked", baseline=baseline)
        with unittest.mock.patch.object(tcr, "edit_files_if_known", return_value="held files"):
            step = tcr.unsettled(unittest.mock.Mock(), current, True)
        self.assertEqual(tcr.changed_fields(current, step.state), tcr.UNSETTLED_CHANGES, "an unsettled edit changed other fields than the fingerprints")
        self.assertEqual(step.state.baseline, baseline, "an unsettled edit changed the baseline")

    def test_changed_fields_names_exactly_the_fields_that_differ(self) -> None:
        self.assertEqual(tcr.changed_fields(State(), State(failed=True, head="abc")), frozenset({"failed", "head"}), "the fields that differ were not named")
        self.assertEqual(tcr.changed_fields(State(), State()), frozenset(), "equal states were told as different")


@dataclass(frozen=True)
class Observed:
    """What a played revert did and told: the outcome of the reset command as the fault saw it, the files that differed from HEAD before the hook ran and after it, and the notice."""
    reset: str
    before: list[str]
    after: list[str]
    told: str
    listing_failed: bool
    saved: bool
    index_copy: bool


AXES: list[tuple[object, ...]] = [RESETS, LATES, (True, False), (EVERY_FILE, SOME_FILES, NO_FILE), (False, True)]
CELLS = pairwise(AXES)


class Playing(HardeningCase):
    """Plays a revert with a fault on a real tree and checks the notice against what the code knows: the outcome of the reset command, the files listed before the reset and the files listed after it."""

    revert_with = faults.RevertFaultTests.revert_with
    fault = faults.RevertFaultTests.fault
    snapshot = faults.RevertFaultTests.snapshot

    def names(self) -> list[str]:
        """The files that differ from HEAD now, those of submodules apart."""
        submodules = {line.split("\t")[1] for line in git(self.cwd, ["ls-files", "--stage"]).splitlines() if line.startswith(GITLINK_MODE)}
        names = {*git(self.cwd, ["diff", "--name-only", "--no-renames", "HEAD"]).splitlines(), *git(self.cwd, ["ls-files", "--others", "--exclude-standard"]).splitlines()} - submodules
        return sorted(names)

    def play(self, injected: faults.Fault, *, after_reset: Callable[[], None] | None = None, listing_fails: bool = False, fresh_file: bool = False,
             saved: bool = True, index_copy: bool = False) -> Observed:
        runner = injected.runner()

        def runs_and_then_acts(argv: list[str], *arguments: object, **options: object) -> subprocess.CompletedProcess[bytes]:
            try:
                return runner(argv, *arguments, **options)
            finally:
                if argv[:4] == faults.RESET_COMMAND and after_reset is not None:
                    after_reset()

        listed = checkpoint.uncommitted

        def fails_once_the_reset_was_tried(root: Path) -> list[str]:
            if injected.reset_ran:
                raise checkpoint.CheckpointError("git diff could not run: timed out")
            return listed(root)

        reverted = checkpoint.revert

        def revert(cwd: Path, **options: object) -> str | None:
            before_discard = options["before_discard"]

            def discard(ref: str | None) -> None:
                before_discard(ref)
                put(cwd / LATE_FILE, "late\n")

            return reverted(cwd, **{**options, "before_discard": discard})

        before = self.names()
        with contextlib.ExitStack() as stack:
            stack.enter_context(unittest.mock.patch.object(subprocess, "run", runs_and_then_acts))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            if listing_fails:
                stack.enter_context(unittest.mock.patch.object(checkpoint, "uncommitted", fails_once_the_reset_was_tried))
            if fresh_file:
                stack.enter_context(unittest.mock.patch.object(checkpoint, "revert", revert))
            told = self.context(self.call_here("PostToolUse", **EDITING))
        return Observed(injected.reset_result, before, self.names(), told, listing_fails, saved, index_copy)

    def assert_told_what_is_known(self, seen: Observed, label: str) -> None:
        """The first sentence claims a revert only when the reset command succeeded; the files are told restored or still changed only by the two listings, and `git status` is named as the present state whenever the files are not told as a revert."""
        told = seen.told
        done = seen.reset == faults.RESET_DONE
        self.assertEqual("TCR reverted" in told, done, f"{label}: the reset result was {seen.reset!r}, and the notice said: {told!r}")
        self.assertEqual("TCR tried to revert" in told, not done, f"{label}: the reset result was {seen.reset!r}, and the notice said: {told!r}")
        self.assertNotIn("because git could not", told, f"{label}: the notice names a cause it does not know: {told!r}")
        sentences = {"Restored:": [], "Still changed:": [], "Changed after TCR listed the files:": [], "Now as HEAD has them:": []}
        if not seen.listing_failed:
            came_back = sorted(set(seen.before) - set(seen.after))
            sentences = {"Restored:": came_back if done else [], "Still changed:": sorted(set(seen.before) & set(seen.after)),
                         "Changed after TCR listed the files:": sorted(set(seen.after) - set(seen.before)), "Now as HEAD has them:": [] if done else came_back}
        for sentence, expected in sentences.items():
            self.assertEqual(names_after(told, sentence), expected, f"{label}: the files after {sentence!r} are not what the two listings give: {told!r}")
        self.assertNotIn("unchanged", told, f"{label}: the notice claims what no listing shows: {told!r}")
        self.assertEqual("`git status` shows the present state." in told, not done or seen.listing_failed, f"{label}: the notice misstates that git status shows the state: {told!r}")
        self.assertEqual("refs/overwatch/reverted/" in told, seen.saved, f"{label}: the notice misstates the saved ref: {told!r}")
        self.assertEqual("^2" in told, seen.saved and seen.index_copy, f"{label}: the notice misstates the staged copy: {told!r}")


class NoticeTruthTests(Playing):
    """The notice of a revert, for a pairwise cover of the reset and the listing after it, a late write, the saved copy, the tree and the index copy, on a real tree whose files can be restored all, in part or not at all."""

    files = EVERY_FILE
    index_copy = False

    def start_the_tree(self) -> None:
        make_dir(self.cwd / LOCKED_DIRECTORY)
        put(self.cwd / LOCKED_FILE, COMMITTED)
        self.start_a_python_project()
        self.fail_pytest()
        staged_name = "second.txt" if self.files == EVERY_FILE else LOCKED_FILE
        if self.index_copy:
            write(self.cwd / staged_name, faults.STAGED_VERSION, None if self.files == EVERY_FILE else COMMITTED)
            git(self.cwd, ["add", staged_name])
        if self.files != NO_FILE:
            write(self.cwd / "pyproject.toml", faults.EDITED_PROJECT_FILE, PROJECT_FILE)
        if self.files == EVERY_FILE:
            write(self.cwd / "second.txt", "edit\n", faults.STAGED_VERSION if self.index_copy else None)
        else:
            write(self.cwd / LOCKED_FILE, "edit\n", faults.STAGED_VERSION if self.index_copy else COMMITTED)

    def late_write(self, late: str) -> Callable[[], None] | None:
        rewritten = LOCKED_FILE if self.files == NO_FILE else "pyproject.toml"
        deleted = "second.txt" if self.files == EVERY_FILE else rewritten

        def acts() -> None:
            with contextlib.suppress(OSError):
                remove_fixture_file(self.cwd / deleted) if late == LATE_DELETE else put(self.cwd / rewritten, PERSON_VERSION)

        return acts if late in (LATE_REWRITE, LATE_DELETE) else None

    def test_the_notice_claims_only_what_the_reset_and_the_two_listings_show(self) -> None:
        self.start_the_tree()
        restore = self.snapshot()
        locked = self.cwd / LOCKED_DIRECTORY
        cells = [row for row in CELLS if row[TREE_AXIS] == self.files and row[INDEX_AXIS] == self.index_copy]
        for (reset, listing), late, saved, _, _ in cells:
            restore()
            if self.files != EVERY_FILE:
                set_mode(locked, faults.READ_ONLY_DIRECTORY)
            label = f"{self.files}; index copy {self.index_copy}; {reset}; {listing}; late {late}; {'saved' if saved else 'not saved'}"
            with self.subTest(label), contextlib.ExitStack() as stack:
                if not saved:
                    read_settings = tcr.read_settings
                    stack.enter_context(unittest.mock.patch.object(tcr, "read_settings", lambda override: replace(read_settings(override), save_reverted=False)))
                seen = self.play(faults.Fault(self.cwd, reset), after_reset=self.late_write(late), listing_fails=listing == LISTING_FAILS, fresh_file=late == LATE_FRESH,
                                 saved=saved, index_copy=self.index_copy)
                set_mode(locked, faults.WRITABLE_DIRECTORY)
                self.assert_told_what_is_known(seen, label)
        self.assertTrue(cells, f"the cover has no cell for {self.files} with index copy {self.index_copy}")


class SomeFilesRestorableTests(NoticeTruthTests):
    files = SOME_FILES


class NoFileRestorableTests(NoticeTruthTests):
    files = NO_FILE


class EveryFileWithAnIndexCopyTests(NoticeTruthTests):
    index_copy = True


class SomeFilesWithAnIndexCopyTests(NoticeTruthTests):
    files = SOME_FILES
    index_copy = True


class NoFileWithAnIndexCopyTests(NoticeTruthTests):
    files = NO_FILE
    index_copy = True


class TableTests(unittest.TestCase):
    def test_the_cover_holds_every_pair_of_values_and_stays_small(self) -> None:
        self.assertEqual(len(set(CELLS)), len(CELLS), "the cover has a row twice")
        self.assertLessEqual(len(CELLS), MAX_COVER_CELLS, "the cover grew past what a run of the table affords")
        for (i, left), (j, right) in itertools.combinations(enumerate(AXES), 2):
            for a, b in itertools.product(left, right):
                self.assertTrue(any(row[i] == a and row[j] == b for row in CELLS), f"no cell has {a} beside {b}")


class NamedCaseTests(Playing):
    """The cases the review found, each on its own tree of a.txt, b.txt and a project: a person writes or deletes a file after the reset, or the reset is refused and a person deletes an untracked file."""

    def start_the_tree(self, saved: bool = True, extra: Callable[[], None] | None = None) -> None:
        put(self.cwd / "a.txt", "A\n")
        put(self.cwd / "b.txt", "B\n")
        if extra is not None:
            extra()
        self.start_a_python_project(None if saved else {"tcr": {"saveReverted": False}})
        self.fail_pytest()

    def play_case(self, reset: str, edit: Callable[[], None], after_reset: Callable[[], None] | None = None, *, saved: bool = True, listing_fails: bool = False,
                  extra: Callable[[], None] | None = None) -> Observed:
        self.start_the_tree(saved, extra)
        edit()
        seen = self.play(faults.Fault(self.cwd, reset), after_reset=after_reset, listing_fails=listing_fails, saved=saved)
        self.assert_told_what_is_known(seen, reset)
        return seen

    def test_a_late_rewrite_of_the_only_restored_file_is_told_as_still_changed(self) -> None:
        seen = self.play_case(faults.TIMES_OUT_AFTER, lambda: write(self.cwd / "pyproject.toml", "agent\n", PROJECT_FILE), lambda: write(self.cwd / "pyproject.toml", "person\n", PROJECT_FILE))
        self.assertEqual(names_after(seen.told, "Still changed:"), ["pyproject.toml"], "a file a person rewrote is not told as still changed")

    def test_a_late_rewrite_of_a_tracked_file_beside_an_untracked_one_names_no_cause(self) -> None:
        def edit() -> None:
            write(self.cwd / "pyproject.toml", "agent\n", PROJECT_FILE)
            write(self.cwd / "second.txt", "edit\n")

        seen = self.play_case(faults.TIMES_OUT_AFTER, edit, lambda: write(self.cwd / "pyproject.toml", "person\n", PROJECT_FILE))
        self.assertIn("pyproject.toml", names_after(seen.told, "Still changed:"), "the file a person rewrote is not told as still changed")

    def test_a_late_delete_of_a_restored_file_is_told_as_still_changed(self) -> None:
        seen = self.play_case(faults.TIMES_OUT_AFTER, lambda: write(self.cwd / "a.txt", "agent\n", "A\n"), lambda: remove_fixture_file(self.cwd / "a.txt"))
        self.assertEqual(names_after(seen.told, "Still changed:"), ["a.txt"], "a file a person deleted is not told as still changed")

    def test_two_restored_files_of_which_one_is_rewritten_late_are_told_still_changed_without_a_cause(self) -> None:
        def edit() -> None:
            write(self.cwd / "a.txt", "agent\n", "A\n")
            write(self.cwd / "b.txt", "agent\n", "B\n")

        seen = self.play_case(faults.TIMES_OUT_AFTER, edit, lambda: write(self.cwd / "a.txt", "person\n", "A\n"))
        self.assertEqual(names_after(seen.told, "Now as HEAD has them:"), ["b.txt"], "the file that is as HEAD has it is not told")

    def test_a_file_named_like_a_fixed_sentence_of_the_notice_is_listed_and_the_hook_still_answers(self) -> None:
        for sentence in ("The files are unchanged.", "Still changed:", "TCR reverted", "No file was restored."):
            for reset in (faults.TIMES_OUT_AFTER, faults.REFUSED, faults.NORMAL):
                with self.subTest(sentence=sentence, reset=reset):
                    self.setUp()
                    self.start_the_tree()
                    write(self.cwd / sentence, "edit\n")
                    seen = self.play(faults.Fault(self.cwd, reset))
                    self.assertIn(f"`{sentence}`", seen.told, "the file named like a sentence is not listed by its name")

    def test_a_refused_reset_followed_by_a_delete_of_an_untracked_file_is_not_told_as_a_revert(self) -> None:
        seen = self.play_case(faults.REFUSED, lambda: write(self.cwd / "second.txt", "edit\n"), lambda: remove_fixture_file(self.cwd / "second.txt"))
        self.assertNotIn("TCR reverted", seen.told, "a refused reset is told as a revert")

    def test_a_refused_reset_with_a_tracked_edit_and_a_deleted_untracked_file_is_not_told_as_a_revert(self) -> None:
        def edit() -> None:
            write(self.cwd / "a.txt", "agent\n", "A\n")
            write(self.cwd / "second.txt", "edit\n")

        seen = self.play_case(faults.REFUSED, edit, lambda: remove_fixture_file(self.cwd / "second.txt"))
        self.assertNotIn("TCR reverted", seen.told, "a refused reset is told as a revert")

    def test_a_reset_that_succeeded_before_a_late_rewrite_is_told_as_a_revert_with_the_file_still_changed(self) -> None:
        seen = self.play_case(faults.NORMAL, lambda: write(self.cwd / "a.txt", "agent\n", "A\n"), lambda: write(self.cwd / "a.txt", "person\n", "A\n"))
        self.assertIn("TCR reverted", seen.told, "a reset that succeeded is not told as a revert")
        self.assertEqual(names_after(seen.told, "Still changed:"), ["a.txt"], "the rewritten file is not told as still changed")

    def test_a_reset_nobody_can_vouch_for_with_a_listing_that_fails_and_no_saved_copy_makes_no_claim_about_the_files(self) -> None:
        seen = self.play_case(faults.TIMES_OUT_AFTER, lambda: write(self.cwd / "a.txt", "agent\n", "A\n"), saved=False, listing_fails=True)
        self.assertIn("No copy was saved", seen.told, "the notice does not say that nothing was saved")
        self.assertNotIn("is gone", seen.told, "the notice says the work is gone where nobody knows")

    def test_a_reset_that_times_out_before_it_ran_with_a_listing_that_fails_makes_no_claim_about_the_files(self) -> None:
        seen = self.play_case(faults.TIMES_OUT_BEFORE, lambda: write(self.cwd / "a.txt", "agent\n", "A\n"), listing_fails=True)
        self.assertIn("`git status` shows the present state.", seen.told, "the notice does not point at git status")

    def test_a_refused_reset_with_no_saved_copy_lists_the_file_as_still_changed_and_says_that_no_copy_was_saved(self) -> None:
        seen = self.play_case(faults.REFUSED, lambda: write(self.cwd / "a.txt", "agent\n", "A\n"), saved=False)
        self.assertEqual(names_after(seen.told, "Still changed:"), ["a.txt"], "a refused reset does not list the file as still changed")
        self.assertIn("No copy was saved", seen.told, "the notice does not say that nothing was saved")

    def add_a_submodule(self) -> None:
        source = self.cwd.parent / (self.cwd.name + "_subrepo")
        source.mkdir()
        identity = ["-c", "user.name=t", "-c", "user.email=t@t"]
        for command in (["init", "-q"], [*identity, "commit", "--allow-empty", "-qm", "init"]):
            subprocess.run(["git", *command], cwd=source, check=True, capture_output=True)
        put(source / "f.txt", "f\n")
        subprocess.run(["git", "add", "."], cwd=source, check=True)
        subprocess.run(["git", *identity, "commit", "-qm", "file"], cwd=source, check=True)
        subprocess.run(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), SUBMODULE], cwd=self.cwd, check=True, capture_output=True)

    def dirty_a_submodule(self) -> None:
        write(self.cwd / "a.txt", "agent\n", "A\n")
        write(self.cwd / SUBMODULE / "f.txt", "dirty\n", "f\n")

    def test_a_real_submodule_that_holds_changes_is_named_as_not_restored_after_a_normal_reset(self) -> None:
        seen = self.play_case(faults.NORMAL, self.dirty_a_submodule, extra=self.add_a_submodule)
        self.assertIn(f"`{SUBMODULE}`", seen.told, "the submodule that holds changes is not named")
        self.assertIn("were not restored and still hold changes", seen.told, "the submodule note is missing")

    def test_a_real_submodule_that_holds_changes_is_named_apart_from_the_files_still_changed_after_a_refused_reset(self) -> None:
        seen = self.play_case(faults.REFUSED, self.dirty_a_submodule, extra=self.add_a_submodule)
        self.assertEqual(names_after(seen.told, "Still changed:"), ["a.txt"], "the file that is still changed is not listed apart from the submodule")
        self.assertIn(f"`{SUBMODULE}`", seen.told, "the submodule that holds changes is not named")


if __name__ == "__main__":
    unittest.main()
