"""A test that no assert in the plugin's hooks looks at text a file, a check or a summary gave, unless it is listed here with the reason it cannot fail on such text, and that none is in a function that runs after a revert has discarded the work: an assert that raises there replaces the notice of the revert, and one that raises before a tool leaves the person guard off. The asserts are found in the source by the reader of ts_source.py.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest

from hook_assertions import TextAssert, asserts_of, every_assert, functions_after_the_revert, functions_before_the_tool, length_asserts_of, length_asserts_where_a_raise_costs, text_asserts

PATH = "a path the plugin made absolute or took from the host's session directory before this call; no file, check or summary text decides how it starts or ends"
OWN = "a name, key or word the plugin built from its own words, which no file, check or summary text can make empty"
FIXED = "a membership in a list of fixed words the plugin wrote, or a comparison with one of them, not a text a file, check or summary gave"
OBJECT = "a membership of an object in a list of objects, not a text"
TYPE = "a test of the type of a value, which holds or fails by the type alone and not by what the text says"
VALIDATED = "the assert follows a raise of a CommandError for the same condition, so it holds for every answer the engine or git gives"
GATING = "an invariant of the parser of the agent's command, which tests/gating-hostile.test.ts runs over every hostile text of the matrix and a pseudo-random mix of quotes and operators and never saw broken"
BY_CONSTRUCTION = "holds by how the value is made: the text is cut or joined at that character, or the path is made from the other one"
COUNT = "the count of a list or a set the plugin built from its own items, which no file, check or summary text makes shorter or longer than the code expects"
ALLOWED: dict[tuple[str, str, str], str] = {
    ('delivery.ts', 'setStatus', 'state.liveWatchers.includes(live)'): OBJECT,
    ('delivery.ts', 'setStatus', "text === undefined || typeof text === 'string'"): TYPE,
    ('delivery.ts', 'send', "text !== ''"): OWN,
    ('delivery.ts', 'queue', "signature !== ''"): OWN,
    ('delivery.ts', 'queue', 'state.outbox.get(key) === message'): OBJECT,
    ('gating.ts', 'baseName', "!name.includes('/')"): GATING,
    ('gating.ts', 'baseName', "name.length <= (word ?? '').length"): GATING,
    ('gating.ts', 'shellCommands', 'kept.length <= text.length + 1'): GATING,
    ('gating.ts', 'isPrefix', "!prefix || word !== ''"): GATING,
    ('gating.ts', 'isPrefix', '!prefix || ASSIGNMENT.test(word) || WRAPPERS.has(word) || CONTROL_WORDS.has(word)'): GATING,
    ('gating.ts', 'shellScript', 'script === undefined || words.includes(script)'): GATING,
    ('gating.ts', 'gitSubcommand', "found === undefined || baseName(words[0]) === 'git'"): GATING,
    ('gating.ts', 'gitSubcommand', "found === undefined || !found.startsWith('-')"): GATING,
    ('gating.ts', 'bringsInFiles', "!found || command.trim() !== ''"): GATING,
    ('hold-notices.ts', 'leftUncommitted', "reason !== ''"): OWN,
    ('judgement.ts', 'decisionOf', "root.startsWith('/')"): PATH,
    ('deciding.ts', 'noteBranch', "root.startsWith('/')"): PATH,
    ('deciding.ts', 'pauseForOutsideChange', "root.startsWith('/')"): PATH,
    ('checkpoint-head.ts', 'noteHead', "root.startsWith('/')"): PATH,
    ('deciding.ts', 'noteBranch', "branch === undefined || branch !== ''"): OWN,
    ('judgement.ts', 'fingerprintOrPause', "root.startsWith('/')"): PATH,
    ('judgement.ts', 'noteFiles', "tool !== ''"): OWN,
    ('judgement.ts', 'judgeFound', "root.startsWith('/')"): PATH,
    ('judgement.ts', 'judgeFound', "liveWatchers.every(each => each.dir.startsWith('/'))"): PATH,
    ('judgement.ts', 'judgeChecks', "liveWatchers.length > 0 && root.startsWith('/')"): PATH,
    ('judgement.ts', 'changedWhileJudging', 'written.every(name => !before.includes(name))'): OBJECT,
    ('judgement.ts', 'holdTcr', "reason !== ''"): OWN,
    ('judgement.ts', 'holdTcr', "files !== ''"): OWN,
    ('judgement.ts', 'isUnchanged', "root.startsWith('/') && files !== ''"): PATH,
    ('judgement.ts', 'checkpointTcr', "files !== ''"): OWN,
    ('judgement.ts', 'revertAttempt', "files !== '' && root.startsWith('/')"): PATH,
    ('pausing.ts', 'activeSettings', "root.startsWith('/')"): PATH,
    ('project.ts', 'realPath', "path !== ''"): OWN,
    ('project.ts', 'realPath', "resolved !== ''"): OWN,
    ('project.ts', 'repositoryOf', "root.startsWith('/')"): BY_CONSTRUCTION,
    ('project.ts', 'commitOf', "root.startsWith('/')"): PATH,
    ('project.ts', 'resolvedFrom', "base.startsWith('/')"): PATH,
    ('project.ts', 'resolvedFrom', "!parts.includes('..') && !parts.includes('.')"): BY_CONSTRUCTION,
    ('project.ts', 'gitDirectoryOf', "root.startsWith('/')"): PATH,
    ('project.ts', 'gitDirectoryOf', "directory === undefined || directory.startsWith('/')"): PATH,
    ('project.ts', 'commonDirectoryOf', "own.startsWith('/')"): PATH,
    ('project.ts', 'commonDirectoryOf', "common.startsWith('/')"): PATH,
    ('project.ts', 'branchOf', "root.startsWith('/')"): PATH,
    ('project.ts', 'isCommitted', "root.startsWith('/')"): PATH,
    ('project.ts', 'readSettings', "typeof cwd === 'string' && cwd !== ''"): PATH,
    ('project.ts', 'isOverride', "['object', 'string', 'number', 'boolean'].includes(typeof settings)"): TYPE,
    ('project.ts', 'readOverride', "typeof cwd === 'string' && cwd !== ''"): PATH,
    ('project.ts', 'hasMarker', "marker !== '' && !marker.startsWith('/')"): PATH,
    ('project.ts', 'findSubprojects', "found.every(({ dir }) => dir.split('/').length <= SEARCH.depth)"): BY_CONSTRUCTION,
    ('project.ts', 'onPath', "name !== '' && !name.includes('/')"): PATH,
    ('project.ts', 'onPath', "dirs.every(dir => !dir.includes(':'))"): BY_CONSTRUCTION,
    ('project.ts', 'isOnPath', "name !== '' && !name.includes('/')"): PATH,
    ('project.ts', 'isOnPath', 'found === undefined || found.endsWith(`/${name}`)'): BY_CONSTRUCTION,
    ('project.ts', 'findIn', "placed.every(({ dir }) => dir !== '')"): OWN,
    ('register.ts', 'start', 'state.liveWatchers.includes(live)'): OBJECT,
    ('register.ts', 'afterTool', "tool !== ''"): OWN,
    ('state.ts', 'liveWatcher', 'key.endsWith(`:${dir}`)'): BY_CONSTRUCTION,
    ('tcr.ts', 'constructor', 'RESETS.includes(outcome.reset)'): FIXED,
    ('tcr.ts', 'flagOf', "name === 'changed' || name === 'staged'"): FIXED,
    ('tcr.ts', 'unavailableOf', "unavailable === null || unavailable !== ''"): VALIDATED,
    ('tcr-settings.ts', 'settingError', "TCR_FIELDS.includes(field) && wanted !== ''"): FIXED,
    ('tcr.ts', 'identityOf', "root.startsWith('/')"): PATH,
    ('tcr.ts', 'stateOf', "root.startsWith('/')"): PATH,
    ('tcr.ts', 'verdictOf', "key !== ''"): OWN,
    ('tcr.ts', 'verdictOf', "verdict === 'fine' || report.isFailed"): FIXED,
    ('tcr.ts', 'runCheck', "spawn.cwd.startsWith('/')"): PATH,
    ('toolchain.ts', 'toolchainOf', "resolved === undefined || resolved !== ''"): OWN,
    ('toolchain.ts', 'replacedToolchain', "live.toolchain === undefined || live.toolchain !== ''"): OWN,
    ('toolchain.ts', 'restartOnReplaced', "replaced !== '' && replaced !== live.toolchain"): OWN,
    ('watchers.ts', 'pattern', '[...flags].every(flag => compiled.flags.includes(flag))'): FIXED,
    ('watchers.ts', 'environmentIn', "ENVIRONMENT.length > 0 && (line === undefined || typeof line === 'string')"): TYPE,
    ('watchers.ts', 'overrideWatcher', "commandLine(watcher) !== '' || watcher.argv !== undefined"): BY_CONSTRUCTION,
    ('watchers.ts', 'hasRegression', "grew.every(([kind]) => kind !== '')"): OWN,
    ('watchers.ts', 'timingLine', "lines.length === 0 || watcher.argv!.includes('--testmon')"): FIXED,
}
LENGTH_ALLOWED: dict[tuple[str, str, str], str] = {
    ('completion.ts', 'guardedFailure', 'blocked.length <= state.liveWatchers.length'): COUNT,
    ('gating.ts', 'commandOf', 'given !== undefined || command.length === 0'): BY_CONSTRUCTION,
    ('gating.ts', 'readGate', 'Array.isArray(gate.protected_actions) && gate.protected_actions.length === entries.length'): BY_CONSTRUCTION,
    ('judgement.ts', 'build', 'parts.length === causes.length'): COUNT,
    ('judgement.ts', 'failedRevert', 'failure.outcome.reset === reset && causes.length > 0'): COUNT,
    ('revert-aftermath.ts', 'settleRevert', 'listing.length > 0'): COUNT,
    ('judgement.ts', 'tellBrokenRevert', 'attempt.isSpawned && causes.length > 0'): COUNT,
    ('notice-files.ts', 'listed', 'shown.length <= MESSAGE_FILES && hidden >= 0'): COUNT,
    ('notice-files.ts', 'listed', 'names.length === 0 || shown.length > 0'): COUNT,
    ('pausing.ts', 'queueTcr', 'key.length > 0'): OWN,
    ('pausing.ts', 'cancelJudgement', 'state.epoch !== epoch || state.tcrKills.size === 0 || kills.length > 0'): COUNT,
    ('project.ts', 'repositoryOf', 'parent.length < at.length'): BY_CONSTRUCTION,
    ('project.ts', 'readSettings', 'path.length > cwd.length'): BY_CONSTRUCTION,
    ('revert-aftermath.ts', 'queueRevert', 'logs.length === causes.length'): COUNT,
    ('revert-aftermath.ts', 'stillChanged', 'came.length + remaining.length === listing.length'): COUNT,
    ('revert-aftermath.ts', 'toldOf', 'causes.length > 0 && causes.every(({ report }) => report?.isFailed)'): COUNT,
    ('revert-aftermath.ts', 'toldOf', 'parts.length === causes.length'): COUNT,
    ('revert-notices.ts', 'revertMessage', 'causes.length > 0'): COUNT,
    ('revert-notices.ts', 'revertMessage', 'parts.length === causes.length && (isPart ? files.restored.length > 0 : true)'): COUNT,
    ('revert-notices.ts', 'failingCheck', 'causes.length > 0'): COUNT,
    ('revert-notices.ts', 'failingCheck', 'logs.length <= causes.length'): COUNT,
    ('revert-notices.ts', 'unrevertedMessage', 'causes.length > 0 && failed in FAILED_TEXT'): COUNT,
    ('revert-notices.ts', 'brokenRevertMessage', 'causes.length > 0'): COUNT,
    ('safe-text.ts', 'isUnsafe', '[...character].length === 1'): BY_CONSTRUCTION,
    ('safe-text.ts', 'escape', 'character.length > 0'): BY_CONSTRUCTION,
    ('safe-text.ts', 'escape', '[...character].length === 1'): BY_CONSTRUCTION,
    ('safe-text.ts', 'sizeOf', 'size > 0 && size <= piece.length'): BY_CONSTRUCTION,
    ('safe-text.ts', 'written', 'limit === undefined || limit > CUT.length'): BY_CONSTRUCTION,
    ('safe-text.ts', 'safeName', 'NAME_LIMIT > CUT.length'): BY_CONSTRUCTION,
    ('safe-text.ts', 'safeLine', '[...result].length >= [...text].length'): BY_CONSTRUCTION,
    ('tcr-settings.ts', 'readTcrSettings', 'Object.keys(fields).length <= TCR_FIELDS.length'): VALIDATED,
    ('tcr.ts', 'initialTcr', 'Object.keys(tcr).length === 5'): COUNT,
    ('tcr.ts', 'runWithin', 'spawn.argv.length > 0 && ms > 0'): COUNT,
    ('tcr.ts', 'endOf', 'lines.length > 0 && kept.length > 0'): BY_CONSTRUCTION,
    ('tcr.ts', 'endOf', 'kept.length <= PRINTED_LINES + 2'): BY_CONSTRUCTION,
    ('tcr.ts', 'cutLine', 'characters.length > 0 || cut.length === 0'): BY_CONSTRUCTION,
    ('tcr.ts', 'namesInStatus', "typeof text === 'string' && fields.length > 0"): BY_CONSTRUCTION,
    ('tcr.ts', 'namesInStatus', 'names.length >= fields.filter(entry => entry.length > 3).length'): BY_CONSTRUCTION,
    ('tcr.ts', 'dirtyFiles', 'Array.isArray(names) && (code === 0 || names.length === 0)'): VALIDATED,
    ('watchers.ts', 'commandLine', 'words.length === argv.length'): COUNT,
    ('watchers.ts', 'failingLine', "failures.length > 0 && typeof more === 'string'"): COUNT,
    ('watchers.ts', 'logLine', 'lines.length === (log === undefined ? 0 : 1)'): COUNT,
}
NOT_FOUND = "the allowlist names an assert that is no longer in the hooks"
REVERT_PATH_FUNCTIONS = ("failedRevert", "inspectRestored", "revertMessage", "unrevertedMessage", "keptLine", "listed", "safeName", "safePath", "safeLine", "writeLog", "dirtyFiles", "fingerprintOf")


class TextAssertTests(unittest.TestCase):
    def test_every_assert_over_text_is_listed_with_its_reason_and_the_list_holds_no_assert_that_is_gone(self) -> None:
        found = {each.key for each in text_asserts()}
        self.assertEqual(found - set(ALLOWED), set(), "an assert looks at text and is not in the list; delete it, or list it with the reason it cannot fail on text a file, check or summary gave")
        self.assertEqual(set(ALLOWED) - found, set(), NOT_FOUND)
        self.assertEqual([key for key, reason in ALLOWED.items() if not reason], [], "an entry has no reason")

    def test_no_assert_over_text_is_in_a_function_that_runs_after_a_revert_even_when_it_is_listed(self) -> None:
        after = functions_after_the_revert()
        self.assertLessEqual(set(REVERT_PATH_FUNCTIONS), after, "the walk from the revert misses a function that runs after it")
        self.assertEqual([each for each in text_asserts() if each.function in after], [], "an assert over text runs after a revert, where it replaces the notice of the revert")
        self.assertEqual([key for key in ALLOWED if key[1] in after], [], "the list holds an assert of a function that runs after a revert")

    def test_every_assert_over_a_length_where_a_raise_costs_the_notice_or_the_guard_is_listed_with_its_reason_and_the_list_holds_none_that_is_gone(self) -> None:
        found = {each.key for each in length_asserts_where_a_raise_costs()}
        self.assertEqual(found - set(LENGTH_ALLOWED), set(), "an assert looks at a length in a function that runs after a revert or before a tool; delete it, or list it with the reason it cannot fail on text a file, check or summary gave")
        self.assertEqual(set(LENGTH_ALLOWED) - found, set(), NOT_FOUND)
        self.assertEqual([key for key, reason in LENGTH_ALLOWED.items() if not reason], [], "an entry has no reason")

    def test_the_scan_finds_a_message_content_assert_and_passes_over_a_count_a_type_and_a_flag(self) -> None:
        source = "function f(message: string, n: number) {\n  assert(!message.includes('x'), `m`)\n  assert(n > 0, `n`)\n  assert(typeof message === 'string', `t`)\n  assert(message !== '', `e`)\n  assert(Number.isInteger(n) && n < MAX, `i`)\n}\nconst g = (text: string) => assert(text.startsWith('a'), `s`)\n"
        found = {(each.function, each.condition): is_text for each, is_text in asserts_of("x.ts", source)}
        self.assertEqual(found, {("f", "!message.includes('x')"): True, ("f", "n > 0"): False, ("f", "typeof message === 'string'"): False, ("f", "message !== ''"): True, ("f", "Number.isInteger(n) && n < MAX"): False, ("g", "text.startsWith('a')"): True})

    def test_the_scan_finds_a_length_over_a_text_name_or_a_function_result_and_passes_over_the_count_of_an_array(self) -> None:
        found = lambda condition: [is_text for _, is_text in asserts_of("x.ts", f"function f(report: Report, items: string[]) {{\n  assert({condition}, `a`)\n}}\n")]
        self.assertEqual(found("report.summary.length < 9"), [True])
        self.assertEqual(found("bareSummary(report).length < 9"), [True])
        self.assertEqual(found("items.map(each => each.id).length === items.length"), [False])
        self.assertEqual(found("Object.keys(report).length < 9"), [False])
        self.assertEqual(found("items.length < 9"), [False])

    def test_the_scan_finds_a_length_in_a_function_that_runs_after_a_revert_or_before_a_tool_over_any_name(self) -> None:
        for function in ("revertMessage", "noteFilesBefore"):
            with self.subTest(function):
                source = f"function {function}(root: string) {{\n  assert(root.length > 1, `a`)\n}}\n"
                self.assertEqual([has for _, has in length_asserts_of("x.ts", source)], [True])
        self.assertLessEqual({"revertMessage"}, functions_after_the_revert())
        self.assertLessEqual({"noteFilesBefore"}, functions_before_the_tool())

    def test_the_limits_of_the_scan_are_misses_of_it_today(self) -> None:
        misses = ("function f(entry: string) {\n  assert(entry.length < 3, `a`)\n}\n", "function f(entry: string) {\n  assert(isShort(entry), `a`)\n}\n", "function f(entry: string) {\n  assert(isShort(entry), `a`)\n}\n", "function f(entry: string) {\n  check(entry.includes('x'), `a`)\n}\n")
        for source in misses:
            with self.subTest(source):
                self.assertEqual([is_text for _, is_text in asserts_of("x.ts", source) if is_text], [], "the limit no longer holds; update the limits")

    def test_the_hooks_hold_hundreds_of_asserts_and_the_scan_reads_each_of_them(self) -> None:
        every = every_assert()
        self.assertGreater(len(every), 300, "the scan found fewer than three hundred asserts")
        self.assertEqual([each.function for each, _ in every if each.function == "" and each.file not in ("register.ts",)], [], "an assert is in no function the scan knows")
        self.assertEqual(sum(1 for _, is_text in every if is_text), len(ALLOWED), "the asserts over text and the list differ in number")


if __name__ == "__main__":
    unittest.main()
