"""Tests that no failure of a stop, a question to the checkpoint command or a read is swallowed by the hooks without a named reason.

A `.catch(() => undefined)`, a `.then(ok, () => undefined)`, an empty `catch` (also one that holds only a comment) and a `catch` that only returns a literal turn any failure into nothing; an arrow function may name its error with no parentheses. The forms it reads as nothing are `undefined`, `null`, `[]`, `{}`, a boolean, a number, a string, an upper-case name, `void 0` and `Promise.resolve()`, each also in parentheses or with `as` and a type, as an arrow function, as a function expression, or as a block that holds only a bare `return` or a `return` of one of them. A check that could not be stopped once kept running unseen that way. The scan reads the source with the tokenizer of ts_source.py and finds each such handler by its file and its text. A handler the table REASONS does not hold fails, so a new swallow must name why the failure may be dropped, or tell the failure. The scan compares how many handlers each file and text has with the table. It does not look at a handler that uses the error it was given, a handler that is a named function or a call such as `orElse(undefined)` or `noop()`, a handler that returns `Promise.resolve(undefined)` or another call, a swallow through an alias or `Promise.allSettled`, or a file outside hooks/, and it does not judge whether a named reason is a good one: that is for the reader of the table. Four of these are pinned as misses below. The same limits are in the README.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

import paths
from codex_hook import read
from ts_source import arguments, calls, closing, masked

HOOKS = paths.ROOT / "hooks"
NOTHING = r"(?:undefined|null|\[\]|\{\s*\}|false|true|-?\d+|'[^']*'|\"[^\"]*\"|[A-Z][A-Z0-9_]*|void\s+0|Promise\.resolve\(\s*\))(?:\s+as\s+[\w$.\[\]<>| ]+)?"
VALUE = rf"(?:\(\s*{NOTHING}\s*\)|{NOTHING})"
COMMENTED = r"[\s\x01]*"
BODY = rf"(?:{VALUE}|\{{{COMMENTED}(?:return(?:\s+{VALUE})?;?)?{COMMENTED}\}})"
PARAMETER = r"\(\s*(?:[\w$]+(?:\s*:\s*[\w$]+)?)?\s*\)"
ARROW_PARAMETER = rf"(?:{PARAMETER}|[\w$]+)"
SWALLOWING_ARROW = re.compile(rf"^(?:async\s+)?{ARROW_PARAMETER}\s*=>\s*{BODY}$")
SWALLOWING_FUNCTION = re.compile(rf"^(?:async\s+)?function\s*{PARAMETER}\s*\{{{COMMENTED}(?:return(?:\s+{VALUE})?;?)?{COMMENTED}\}}$")
SWALLOWING_CATCH = re.compile(rf"\bcatch\s*(?:\(\s*[\w$]*\s*\))?\s*\{{{COMMENTED}(?:return(?:\s+{VALUE})?;?)?{COMMENTED}\}}")


def is_swallowing(handler: str) -> bool:
    """Whether the text of a handler is an arrow function or a function expression that turns its error into nothing."""
    return SWALLOWING_ARROW.match(handler) is not None or SWALLOWING_FUNCTION.match(handler) is not None


def swallows(source: str) -> list[str]:
    """Each handler of source that turns a failure into nothing, as written: the argument of a `.catch(`, the second argument of a `.then(`, and the whole of a `catch` block."""
    code = masked(source)
    found = [source[first:last].strip() for opening in calls(code, "catch") if code[opening - len("catch") - 1] == "."
             for first, last in arguments(code, opening)[:1] if is_swallowing(code[first:last].strip())]
    for opening in calls(code, "then"):
        spans = arguments(code, opening)
        if code[opening - len("then") - 1] == "." and len(spans) == 2 and is_swallowing(code[spans[1][0]:spans[1][1]].strip()):
            found.append(source[spans[1][0]:spans[1][1]].strip())
    for match in SWALLOWING_CATCH.finditer(code):
        found.append(re.sub(r"\s+", " ", source[match.start():match.end()]))
    return found


REASONS = {
    ("register.ts", "() => undefined"): ("the search for checks that outlasted its limit has no result to wait for once the session ended", 1),
    ("delivery.ts", "() => undefined"): ("a log that cannot be written leaves the notice with no log path to name", 1),
    ("delivery.ts", "() => false"): ("an inventory that cannot be written is not offered to the agent", 1),
    ("judgement.ts", "() => undefined"): ("the copy of a decision that others wait for only marks its end, and the decision's own failure goes to its caller", 1),
    ("boundary.ts", "catch { return UNWRITABLE }"): ("an error that cannot be written as text is named as such", 1),
    ("project.ts", "catch { return {} }"): ("a settings file that is no JSON holds no settings, as the engine reads it", 1),
}


def found_in_hooks() -> dict[tuple[str, str], int]:
    """How many swallowing handlers each file of the hooks has, by its text."""
    counts: dict[tuple[str, str], int] = {}
    for path in sorted(HOOKS.glob("*.ts")):
        for text in swallows(read(path)):
            counts[(path.name, text)] = counts.get((path.name, text), 0) + 1
    return counts


class SwallowedErrorTests(unittest.TestCase):
    def test_every_swallowing_handler_of_the_hooks_has_a_named_reason(self) -> None:
        found = found_in_hooks()
        self.assertEqual({key: count for key, count in found.items() if key not in REASONS}, {}, "a failure is swallowed with no named reason; tell it or name why it may be dropped")
        self.assertEqual({key: (found.get(key, 0), count) for key, (_, count) in REASONS.items() if found.get(key, 0) != count}, {}, "a reason names a handler the hooks no longer have, or in another number")

    def test_the_scan_finds_the_swallows_it_must_reject(self) -> None:
        """Each form of a handler that turns a failure into nothing, as an arrow function, a function expression, a `then` and a `catch` block, is found once."""
        cases = [
            "await kill().catch(() => undefined)",
            "await Promise.all(kills.map(kill => kill().catch(() => undefined)))",
            "await $.env.get('HOME').catch(() => undefined)",
            "await ask().catch((error) => null)",
            "await kill().catch((error: unknown) => undefined)",
            "await write().then(() => path, () => undefined)",
            "try { await kill() } catch {}",
            "try { await kill() } catch (error) { return undefined }",
            "await kill().catch(() => { return })",
            "try { await kill() } catch { return }",
            "await kill().catch(() => void 0)",
            "await kill().catch(() => ({}))",
            "await kill().catch(() => (undefined))",
            "await kill().catch(function () {})",
            "await kill().catch(() => [] as string[])",
            "await kill().catch(() => Promise.resolve())",
            "await kill().catch(error => undefined)",
            "await kill().catch(_ => null)",
            "await kill().catch(async error => undefined)",
            "try { await kill() } catch (error) { /* gone */ }",
            "await kill().catch(() => { // gone\n })",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(len(swallows(case)), 1)

    def test_the_scan_leaves_alone_a_handler_that_uses_the_error_or_tells_it(self) -> None:
        cases = [
            "await kill().catch(error => tell(error))",
            "await kill().catch(error => error)",
            "await kill().catch(orElse(undefined))",
            "await kill().then(() => [], (error: unknown) => [error])",
            "try { await kill() } catch (error) { throw error }",
            "try { await kill() } catch (error) { $.ui.log(String(error)) }",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(swallows(case), [])

    def test_the_scan_misses_the_swallows_that_its_limits_name(self) -> None:
        cases = [
            "const ignore = () => undefined; await kill().catch(ignore)",
            "await Promise.allSettled([kill()])",
            "await kill().catch(() => Promise.resolve(undefined))",
            "await kill().catch(() => noop())",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(swallows(case), [])

    def test_the_scan_reads_every_file_of_the_hooks(self) -> None:
        targets = sorted(HOOKS.glob("*.ts"))
        self.assertGreaterEqual(len(targets), 20)
        self.assertGreaterEqual(sum(len(swallows(read(path))) for path in targets), len(REASONS))


if __name__ == "__main__":
    unittest.main()
