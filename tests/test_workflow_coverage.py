"""A test file that CI never runs must not exist unnoticed. Each Node test file and each Lua spec has to be named in a
command that a step of .github/workflows/test.yml runs. The Python files are found by the `unittest discover` command of
a step, so the check is that its pattern matches every `tests/**/test_*.py` and that each of them lies in a package, as
discover finds no other. The TypeScript files are all run by the step that holds `claude plugin test .`, so the check is
that this step exists and that no `.test.ts` file lies outside tests/, where it would not be found. Files that match no
pattern here (helpers, fixtures) are not tests. Only the `run:` of a step counts: not its name, a comment, an `echo`,
`printf`, `ls` or `cat` line, a `:` command, a command followed by `|| true`, `|| :`, `|| exit 0`, `|| echo` or
`|| printf`, a command after `false &&`, `exit` or `set +e`, a command that `|| (exit 0)`, `|| (true)`, `|| { true; }` or `|| /bin/true`
ignores, one piped into `true` or left in the background by `&`, or a step or job whose `if:` is literally false (`0`, `${{ !true }}`
and `false && ..` too), that has `continue-on-error: true` or that sets a `working-directory`, which moves the paths. A workflow that
starts only by hand, or only for a push to a branch that is not the default one, is reported. Only the block style of `on:` is read. A command followed by `; true` still fails its step, because the shell runs with `-e`. The
checks do not follow a matrix, a composite action, a reusable workflow, a script that runs the tests, a glob such as
`tests/*.mjs`, a step written in flow style, a pipeline that starts with `echo` or `cat`, or an `if:` that is false by an
expression, and they count a command that the workflow never reaches by a `needs:` on no job, by `if: failure()` or by
`if: always() && false`, by a `defaults.run.working-directory`, `timeout-minutes: 0`, a runner no one has or a
`--test-name-pattern`, or that sits in the body of a heredoc: the README lists them.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import fnmatch
import re
from collections.abc import Callable
import unittest
from pathlib import Path

from codex_hook import read
from paths import ROOT

WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
TESTS = ROOT / "tests"
NAMED_IN_A_STEP = ("*.mjs", "*_spec.lua")
DISCOVER = re.compile(r"unittest discover -s tests -p '([^']+)'")
STEP_START = re.compile(r"^(?P<indent>\s*)- (?=\S)")
KEY = re.compile(r"^(?P<indent>\s*)(?:- )?(?P<key>[A-Za-z_][\w-]*):[ \t]*(?P<value>.*)$")
BLOCK_MARKERS = ("|", ">", "|-", ">-", "|+", ">+")
QUOTES = "'\""
OUTPUT_COMMANDS = ("echo", "printf", "ls", "cat", ":")
FALSE_CONDITIONS = ("false", "'false'", '"false"', "0", "null", "!true")
FALSE_AND_ANYTHING = re.compile(r"^(?:false|0|null|!true)\s*&&")
DEFAULT_BRANCH = "main"
TRIGGERS_OF_A_RUN = ("push", "pull_request")
TOP_LEVEL_KEY = re.compile(r"^(?P<key>[A-Za-z_\"'][\w\"'-]*):[ \t]*(?P<value>.*)$")
CHILD_KEY = re.compile(r"^(?P<indent> +)(?P<key>[A-Za-z_][\w-]*):[ \t]*(?P<value>.*)$")
BRANCH_LIST = re.compile(r"^\s+branches:\s*\[(?P<names>[^\]]*)\]")
HERE = ("", ".", "./")
TRUE_CONDITIONS = ("true", "'true'", '"true"')
CONTINUE_ON_ERROR = "continue-on-error"
ALWAYS_SUCCEEDS = r"(?:(?:/\S*/)?(?:true|:)|exit\s+0)"
FAILURE_IGNORED = re.compile(rf"\|\|\s*(?:{ALWAYS_SUCCEEDS}\s*;?\s*$|\(\s*{ALWAYS_SUCCEEDS}\s*\)\s*;?\s*$|\{{\s*{ALWAYS_SUCCEEDS}\s*;\s*\}}\s*;?\s*$|(?:echo|printf)\b)"
                            r"|\|\s*(?:/\S*/)?true\s*;?\s*$|(?<!&)&\s*$")
NEVER_REACHED = re.compile(r"^(?:(?:false|exit(?:\s+\d+)?)\s*(?:&&|;)|true\s*\|\|)")
ENDS_THE_STEP = re.compile(r"^(?:exit\b|set\s+\+e\b)")
TRAILING_COMMENT = re.compile(r"\s+#.*$")
PLUGIN_TEST = "claude plugin test ."
PYTHON_TESTS = "test_*.py"
TYPESCRIPT_TESTS = "*.test.ts"
PACKAGE_MARKER = "__init__.py"
INDENT_OF_A_KEY_AFTER_THE_DASH = 2


def literal(value: str) -> str:
    """The value of an `if:` or flag without a trailing comment and without `${{ }}` around it, in lower case."""
    bare = re.sub(r"^\$\{\{\s*(.*?)\s*\}\}$", r"\1", TRAILING_COMMENT.sub("", value.strip()).strip())
    return bare.lower()


def is_false(condition: str) -> bool:
    """Whether an `if:` is literally false: `false`, or `${{ false }}`, quoted or not, with or without a trailing comment."""
    return literal(condition) in FALSE_CONDITIONS or FALSE_AND_ANYTHING.match(literal(condition)) is not None


def is_true(flag: str) -> bool:
    """Whether a flag such as `continue-on-error:` is literally true, written as is_false writes false."""
    return literal(flag) in TRUE_CONDITIONS


def is_off(fields: dict[str, str]) -> bool:
    """Whether a step or a job never runs its commands to a result that counts: its `if:` is literally false, or its failure is ignored by `continue-on-error: true`."""
    elsewhere = literal(fields.get("working-directory", "")).strip("'\"") not in HERE
    return is_false(fields.get("if", "true")) or is_true(fields.get(CONTINUE_ON_ERROR, "false")) or elsewhere


def job_fields(lines: list[str], steps_index: int) -> dict[str, str]:
    """The keys of the job that holds the `steps:` at steps_index, which are written at the indent of `steps:`, as the text they hold."""
    indent = len(lines[steps_index]) - len(lines[steps_index].lstrip())
    header = steps_index - 1
    while header >= 0 and len(lines[header]) - len(lines[header].lstrip()) >= indent:
        header -= 1
    fields: dict[str, str] = {}
    for line in lines[header + 1:]:
        leading = len(line) - len(line.lstrip())
        if header >= 0 and leading <= len(lines[header]) - len(lines[header].lstrip()):
            break
        found = KEY.match(line)
        if found is not None and leading == indent and not line.lstrip().startswith("- "):
            fields.setdefault(found.group("key"), found.group("value").strip())
    return fields


def step_blocks(workflow: str) -> list[tuple[dict[str, str], list[str]]]:
    """Each step of the `steps:` lists of a workflow as the keys of its job and its lines, comment lines left out: from its dash to the next dash at the same indent."""
    lines = [line for line in workflow.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    blocks: list[tuple[dict[str, str], list[str]]] = []
    for index, line in enumerate(lines):
        if line.strip() != "steps:":
            continue
        marker = STEP_START.match(lines[index + 1]) if index + 1 < len(lines) else None
        if marker is None:
            continue
        indent = len(marker.group("indent"))
        job = job_fields(lines, index)
        for following in lines[index + 1:]:
            leading = len(following) - len(following.lstrip())
            if leading < indent or (leading == indent and not following.lstrip().startswith("- ")):
                break
            if leading == indent:
                blocks.append((job, []))
            blocks[-1][1].append(following)
    return blocks


def step_fields(block: list[str]) -> dict[str, str]:
    """The `run` and `if` of a step, as the text they hold: an inline value, or the lines of a block scalar. Other keys, as `name`, are not run."""
    fields: dict[str, str] = {}
    key_indent = len(block[0]) - len(block[0].lstrip()) + INDENT_OF_A_KEY_AFTER_THE_DASH
    index = 0
    while index < len(block):
        found = KEY.match(block[index])
        index += 1
        if found is None or len(found.group("indent")) + (INDENT_OF_A_KEY_AFTER_THE_DASH if block[index - 1].lstrip().startswith("- ") else 0) != key_indent:
            continue
        key, value = found.group("key"), found.group("value").strip()
        if key == "run" and len(value) > 1 and value[0] == value[-1] and value[0] in QUOTES:
            value = value[1:-1]
        if value in BLOCK_MARKERS:
            body = []
            while index < len(block) and len(block[index]) - len(block[index].lstrip()) > key_indent:
                body.append(block[index].strip())
                index += 1
            value = "\n".join(body)
        fields.setdefault(key, value)
    return fields


def step_commands(run: str) -> list[str]:
    """The commands of a `run:` that count as run: not a comment, an output command or `:`, a command after `exit`, a command that `false &&` or `true ||` keeps from running, and not one whose failure `|| true`, `|| :`, `|| exit 0`, `|| echo` or `|| printf` ignores."""
    commands = []
    for line in run.splitlines():
        command = TRAILING_COMMENT.sub("", line).strip()
        if ENDS_THE_STEP.match(command):
            break
        counts = command and command.split()[0] not in OUTPUT_COMMANDS and not NEVER_REACHED.match(command) and not FAILURE_IGNORED.search(command)
        if counts:
            commands.append(command)
    assert all(commands), f"{commands} include an empty command"
    return commands


def run_commands(workflow: str) -> str:
    """The commands that steps run to a result that counts: see step_commands, without the steps and jobs that is_off names."""
    commands = []
    for job, block in step_blocks(workflow):
        fields = step_fields(block)
        if not is_off(job) and not is_off(fields):
            commands.extend(step_commands(fields.get("run", "")))
    return "\n".join(commands)


def listed_branches(line: str) -> list[str] | None:
    """The branches a `branches: [..]` line names, or None when the line is no such list."""
    found = BRANCH_LIST.match(line)
    names = [name.strip().strip("\"'") for name in found.group("names").split(",") if name.strip()] if found is not None else None
    assert names is None or all(names), f"{line!r} names a branch with no name"
    return names


def on_block(workflow: str) -> list[str]:
    """The lines under the top-level `on:` key of a workflow, comments left out, up to the next top-level key."""
    lines = [line for line in workflow.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    keys = [index for index, line in enumerate(lines) if TOP_LEVEL_KEY.match(line)]
    starts = [index for index in keys if TOP_LEVEL_KEY.match(lines[index]).group("key").strip("\"'") == "on"]
    end = next((index for index in keys if starts and index > starts[0]), len(lines))
    return lines[starts[0] + 1:end] if starts else []


def triggers(workflow: str) -> dict[str, list[str] | None]:
    """The events of the top-level `on:` block of a workflow, each with the branches its `branches: [..]` names, or None when it names none. Only the block style is read."""
    block = on_block(workflow)
    children = [CHILD_KEY.match(line) for line in block]
    event_indent = min((len(child.group("indent")) for child in children if child is not None), default=0)
    found: dict[str, list[str] | None] = {}
    for line, child in zip(block, children):
        if child is not None and len(child.group("indent")) == event_indent:
            found[child.group("key")] = None
        elif found and listed_branches(line) is not None:
            found[list(found)[-1]] = listed_branches(line)
    assert all(names is None or names for names in found.values()), f"{found} names an event with an empty list of branches"
    return found


def runs_on_a_push_or_a_pull_request(workflow: str) -> bool:
    """Whether the workflow starts for a pull request, or for a push to every branch or to DEFAULT_BRANCH, and not only by hand."""
    events = triggers(workflow)
    pushes = "push" in events and (events["push"] is None or DEFAULT_BRANCH in (events["push"] or []))
    assert all(events), f"{events} names an event with no name"
    return pushes or "pull_request" in events


def unnamed(files: list[str], workflow: str) -> list[str]:
    commands = run_commands(workflow)
    return [name for name in files if not re.search(rf"(?<![\w/.-])tests/{re.escape(name)}(?![\w.-])", commands)]


def python_files_outside_the_pattern(files: list[str], workflow: str) -> list[str]:
    patterns = DISCOVER.findall(run_commands(workflow))
    return [name for name in files if not any(fnmatch.fnmatch(Path(name).name, pattern) for pattern in patterns)]


def python_files_outside_a_package(files: list[str], is_package: Callable[[Path], bool]) -> list[str]:
    """The files of tests that discover does not enter: those in a directory below tests for which is_package says it holds no __init__.py."""
    return [name for name in files if any(not is_package(parent) for parent in Path(name).parents if parent != Path("."))]


def tests_dir_files(pattern: str, *, below: bool = False) -> list[str]:
    assert TESTS.is_dir(), f"{TESTS} is no directory"
    found = TESTS.rglob(pattern) if below else TESTS.glob(pattern)
    files = sorted(str(path.relative_to(TESTS)) for path in found)
    assert len(files) == len(set(files)), f"a file of tests/ matching {pattern} was listed twice: {files}"
    return files


def workflows_that_only_mention_a_test() -> dict[str, str]:
    """Each way a workflow mentions a test file without running it."""
    mentions = {
        "the name of a step": "    steps:\n      - name: Test tests/x.mjs\n        run: node --test tests/other.mjs\n",
        "a step whose if is false": "    steps:\n      - name: Test\n        if: ${{ false }}\n        run: node --test tests/x.mjs\n",
        "a step whose if is the word false": "    steps:\n      - if: false\n        run: node --test tests/x.mjs\n",
        "an echo": "    steps:\n      - run: echo \"skip tests/x.mjs\"\n",
        "an echo in a block": "    steps:\n      - run: |\n          echo skip tests/x.mjs\n          true\n",
        "a comment in a block": "    steps:\n      - run: |\n          true # tests/x.mjs\n",
        "a comment line": "    steps:\n      # - run: node --test tests/x.mjs\n      - run: true\n",
        "a key other than run": "    steps:\n      - name: Test\n        env:\n          FILE: tests/x.mjs\n        run: true\n",
        "a job whose if is false": "  jobs:\n    off:\n      if: false\n      runs-on: ubuntu-latest\n      steps:\n        - run: node --test tests/x.mjs\n",
        "a job whose if is false by an expression in braces": "  jobs:\n    off:\n      if: ${{ false }}\n      steps:\n        - run: node --test tests/x.mjs\n",
        "a step whose if is false with a trailing comment": "    steps:\n      - if: false # off\n        run: node --test tests/x.mjs\n",
        "a command whose failure is ignored by || true": "    steps:\n      - run: node --test tests/x.mjs || true\n",
        "a command whose failure is ignored by || exit 0": "    steps:\n      - run: node --test tests/x.mjs || exit 0\n",
        "a command whose failure is ignored by || :": "    steps:\n      - run: node --test tests/x.mjs || :\n",
        "a command whose failure is ignored by || echo": "    steps:\n      - run: node --test tests/x.mjs || echo failed\n",
        "a command whose failure is ignored by || printf": "    steps:\n      - run: node --test tests/x.mjs || printf failed\n",
        "a colon command": "    steps:\n      - run: : node --test tests/x.mjs\n",
        "an ls": "    steps:\n      - run: ls tests/x.mjs\n",
        "a cat": "    steps:\n      - run: cat tests/x.mjs\n",
        "a command after false &&": "    steps:\n      - run: false && node --test tests/x.mjs\n",
        "a command after true ||": "    steps:\n      - run: true || node --test tests/x.mjs\n",
        "a command after exit 0": "    steps:\n      - run: |\n          exit 0\n          node --test tests/x.mjs\n",
        "a command whose failure is ignored by || true;": "    steps:\n      - run: node --test tests/x.mjs || true;\n",
        "a command whose failure is ignored by || exit 0;": "    steps:\n      - run: node --test tests/x.mjs || exit 0;\n",
        "a command whose failure is ignored by || (exit 0)": "    steps:\n      - run: node --test tests/x.mjs || (exit 0)\n",
        "a command whose failure is ignored by || (true)": "    steps:\n      - run: node --test tests/x.mjs || (true)\n",
        "a quoted run whose command is ignored by || true": "    steps:\n      - run: 'node --test tests/x.mjs || true'\n",
        "a command whose failure is ignored by || { true; }": "    steps:\n      - run: node --test tests/x.mjs || { true; }\n",
        "a command whose failure is ignored by || /bin/true": "    steps:\n      - run: node --test tests/x.mjs || /bin/true\n",
        "a command piped into true": "    steps:\n      - run: node --test tests/x.mjs | true\n",
        "a command left in the background": "    steps:\n      - run: node --test tests/x.mjs &\n",
        "a command after set +e": "    steps:\n      - run: |\n          set +e\n          node --test tests/x.mjs\n",
        "a step with a working-directory": "    steps:\n      - working-directory: /tmp\n        run: node --test tests/x.mjs\n",
        "a step whose if is 0": "    steps:\n      - if: 0\n        run: node --test tests/x.mjs\n",
        "a step whose if is the negation of true": "    steps:\n      - if: ${{ !true }}\n        run: node --test tests/x.mjs\n",
        "a step whose if is false and anything": "    steps:\n      - if: ${{ false && true }}\n        run: node --test tests/x.mjs\n",
        "a job with a working-directory": "  jobs:\n    elsewhere:\n      working-directory: /tmp\n      steps:\n        - run: node --test tests/x.mjs\n",
        "a step with continue-on-error": "    steps:\n      - continue-on-error: true\n        run: node --test tests/x.mjs\n",
        "a job with continue-on-error": "  jobs:\n    soft:\n      continue-on-error: true\n      steps:\n        - run: node --test tests/x.mjs\n",
        }
    return mentions


def workflows_that_run_a_test() -> dict[str, str]:
    """Each way a workflow does run a test file."""
    runs = {
        "an inline run": "    steps:\n      - run: node --test tests/x.mjs\n",
        "a block run": "    steps:\n      - name: Test\n        run: |\n          true\n          node --test tests/x.mjs\n",
        "a run after other keys": "    steps:\n      - name: Test\n        env:\n          A: b\n        run: node --test tests/x.mjs\n",
        "a step whose if is an expression": "    steps:\n      - if: github.ref == 'refs/heads/main'\n        run: node --test tests/x.mjs\n",
        "a command after a comment line": "    steps:\n      # tests/x.mjs is slow\n      - run: node --test tests/x.mjs\n",
        "a job after a job whose if is false": "  jobs:\n    off:\n      if: false\n      steps:\n        - run: true\n    on:\n      steps:\n        - run: node --test tests/x.mjs\n",
        "a job whose if is an expression and a step that runs": "  jobs:\n    some:\n      if: github.event_name == 'push'\n      steps:\n        - run: node --test tests/x.mjs\n",
        "a step with a working-directory of the repository": "    steps:\n      - working-directory: .\n        run: node --test tests/x.mjs\n",
        "a command piped into a command that is no true": "    steps:\n      - run: node --test tests/x.mjs | tee out.log\n",
        "a command joined to another by &&": "    steps:\n      - run: node --test tests/x.mjs && echo done\n",
        "a step with continue-on-error false": "    steps:\n      - continue-on-error: false\n        run: node --test tests/x.mjs\n",
        "a command followed by ; true, which fails the step under bash -e": "    steps:\n      - run: node --test tests/x.mjs; true\n",
        "a command followed by || with a command that is no echo": "    steps:\n      - run: node --test tests/x.mjs || exit 1\n",
        "a command before exit": "    steps:\n      - run: |\n          node --test tests/x.mjs\n          exit 0\n",
        "a command after a command with a trailing comment": "    steps:\n      - run: |\n          true # false &&\n          node --test tests/x.mjs\n",
        }
    return runs


class WorkflowCoverageTests(unittest.TestCase):
    def test_each_node_test_and_lua_spec_is_named_in_a_step_of_the_workflow(self) -> None:
        workflow = read(WORKFLOW)
        for pattern in NAMED_IN_A_STEP:
            files = tests_dir_files(pattern)
            self.assertTrue(files, f"no file in tests/ matches {pattern}: the check looks at nothing")
            self.assertEqual(unnamed(files, workflow), [], f"a tests/{pattern} file is in no step of {WORKFLOW.name}, so CI never runs it")

    def test_every_python_test_is_found_by_the_discovery_step(self) -> None:
        workflow = read(WORKFLOW)
        files = tests_dir_files(PYTHON_TESTS, below=True)
        self.assertTrue(DISCOVER.search(run_commands(workflow)), "no step of the workflow runs `unittest discover -s tests -p`")
        self.assertEqual(python_files_outside_the_pattern(files, workflow), [], "a Python test file does not match the pattern of the discovery step")
        self.assertEqual(python_files_outside_a_package(files, lambda directory: (TESTS / directory / PACKAGE_MARKER).is_file()), [], "a Python test file lies in a directory of tests/ without __init__.py, which discover does not enter")

    def test_the_plugin_step_exists_and_every_typescript_test_lies_where_it_finds_them(self) -> None:
        self.assertIn(PLUGIN_TEST, run_commands(read(WORKFLOW)), "no step runs the plugin's TypeScript tests")
        stray = sorted(str(path.relative_to(ROOT)) for path in ROOT.rglob(TYPESCRIPT_TESTS)
                       if "node_modules" not in path.parts and path.parent != TESTS)
        self.assertTrue(tests_dir_files(TYPESCRIPT_TESTS), f"no tests/{TYPESCRIPT_TESTS} file exists: the check looks at nothing")
        self.assertEqual(stray, [], "a .test.ts file outside tests/ is not found by `claude plugin test .`")

    def test_the_workflow_starts_for_a_pull_request_or_a_push_to_the_default_branch(self) -> None:
        self.assertTrue(runs_on_a_push_or_a_pull_request(read(WORKFLOW)), "test.yml starts for no pull request and no push to the default branch, so CI never runs")

    def test_a_workflow_that_never_starts_is_told_apart_from_one_that_does(self) -> None:
        starts = {
            "a push to the default branch and a pull request": "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n",
            "a push to every branch": "on:\n  push:\njobs:\n",
            "a pull request and a manual start": "on:\n  pull_request:\n  workflow_dispatch:\njobs:\n",
        }
        never = {
            "a manual start only": "on:\n  workflow_dispatch:\njobs:\n",
            "a push to a branch that does not exist": "on:\n  push:\n    branches: [nonexistent]\njobs:\n",
            "a schedule only": "on:\n  schedule:\n    - cron: '0 0 * * 0'\njobs:\n",
        }
        for label, workflow in starts.items():
            self.assertTrue(runs_on_a_push_or_a_pull_request(workflow), f"a workflow that starts for {label} was reported as never starting")
        for label, workflow in never.items():
            self.assertFalse(runs_on_a_push_or_a_pull_request(workflow), f"a workflow with {label} was taken to start")

    def test_the_checks_reject_a_workflow_that_leaves_a_file_out(self) -> None:
        workflow = "    steps:\n      - run: node --test tests/test_a.mjs\n      # tests/test_c.mjs\n      - run: python3 -m unittest discover -s tests -p 'test_*.py'\n"
        self.assertEqual(unnamed(["test_a.mjs", "test_b.mjs", "test_c.mjs", "xtest_a.mjs"], workflow), ["test_b.mjs", "test_c.mjs", "xtest_a.mjs"],
                         "a file never named, one named only in a comment and one that only ends like a named file were not all reported")
        self.assertEqual(python_files_outside_the_pattern(["test_a.py", "check_a.py"], workflow), ["check_a.py"], "a Python file the pattern does not match was not reported")
        self.assertEqual(python_files_outside_the_pattern(["test_a.py"], "    steps:\n      - run: true\n"), ["test_a.py"], "a workflow with no discovery step was not reported")

    def test_a_file_is_not_run_when_the_workflow_only_names_it(self) -> None:
        """Each way a workflow mentions a test without running it, and each way it does run it, as the check must tell them apart."""
        mentions = workflows_that_only_mention_a_test()
        for label, workflow in mentions.items():
            with self.subTest(label):
                self.assertEqual(unnamed(["x.mjs"], workflow), ["x.mjs"], f"the check counts a file as run where the workflow has {label}")
        runs = workflows_that_run_a_test()
        for label, workflow in runs.items():
            with self.subTest(label):
                self.assertEqual(unnamed(["x.mjs"], workflow), [], f"the check does not count a file as run where the workflow has {label}")

    def test_the_check_reports_the_workflows_it_does_not_follow_and_counts_some_it_cannot_tell_never_run(self) -> None:
        """What the check does not follow is reported as not run, so the failure is safe, or counted as run."""
        reported = {
            "a glob": "    steps:\n      - run: node --test tests/*.mjs\n",
            "a matrix command": "    steps:\n      - run: node --test tests/${{ matrix.file }}\n",
            "a composite action": "    steps:\n      - uses: ./.github/actions/test-everything\n",
            "a script that runs the tests": "    steps:\n      - run: ./run-tests.sh\n",
            "a reusable workflow": "  jobs:\n    reuse:\n      uses: ./.github/workflows/tests.yml\n",
            "a step in flow style": "    steps:\n      - {name: Test, run: node --test tests/x.mjs}\n",
            "a pipeline that starts with cat": "    steps:\n      - run: cat list.txt | xargs node --test tests/x.mjs\n",
            "a pipeline that starts with echo": "    steps:\n      - run: echo tests/x.mjs | xargs node --test\n",
        }
        for label, workflow in reported.items():
            with self.subTest(label):
                self.assertEqual(unnamed(["x.mjs"], workflow), ["x.mjs"], f"the check follows {label}, which the README says it does not")
        counted = {
            "an if that is false by an expression": "    steps:\n      - if: github.event_name == 'never'\n        run: node --test tests/x.mjs\n",
            "a job that needs a job that does not exist": "  jobs:\n    a:\n      needs: nonexistent\n      steps:\n        - run: node --test tests/x.mjs\n",
            "a step whose if is failure()": "    steps:\n      - if: failure()\n        run: node --test tests/x.mjs\n",
            "a step whose if is always() && false": "    steps:\n      - if: always() && false\n        run: node --test tests/x.mjs\n",
            "a working-directory that a job sets for every step": "  jobs:\n    a:\n      defaults:\n        run:\n          working-directory: /tmp\n      steps:\n        - run: node --test tests/x.mjs\n",
            "a job with a timeout of 0 minutes": "  jobs:\n    a:\n      timeout-minutes: 0\n      steps:\n        - run: node --test tests/x.mjs\n",
            "a job on a runner no one has": "  jobs:\n    a:\n      runs-on: no-such-runner\n      steps:\n        - run: node --test tests/x.mjs\n",
            "a shell if that is false": "    steps:\n      - run: if false; then node --test tests/x.mjs; fi\n",
            "a command after a test that is false": "    steps:\n      - run: '[ -n \"$NEVER\" ] && node --test tests/x.mjs'\n",
            "a pipeline into cat": "    steps:\n      - run: node --test tests/x.mjs | cat\n",
            "a pipeline into head": "    steps:\n      - run: node --test tests/x.mjs | head -50\n",
            "a test skip pattern that skips every test": "    steps:\n      - run: node --test --test-skip-pattern='.*' tests/x.mjs\n",
            "a pipeline into tee": "    steps:\n      - run: node --test tests/x.mjs | tee out.log\n",
            "a shell that is no shell": "    steps:\n      - shell: 'true {0}'\n        run: node --test tests/x.mjs\n",
            "a test name pattern that matches nothing": "    steps:\n      - run: node --test --test-name-pattern=NOPE tests/x.mjs\n",
            "the body of a heredoc": "    steps:\n      - run: |\n          cat > list <<'EOF'\n          node --test tests/x.mjs\n          EOF\n",
        }
        for label, workflow in counted.items():
            with self.subTest(label):
                self.assertEqual(unnamed(["x.mjs"], workflow), [], f"the check does not count a file as run for {label}, which the README says it does")

    def test_the_discovery_pattern_is_the_one_a_step_runs_and_not_one_that_is_echoed(self) -> None:
        echoed = "    steps:\n      - run: echo \"unittest discover -s tests -p 'test_*.py'\"\n      - run: python3 -m unittest discover -s tests -p 'check_*.py'\n"
        self.assertEqual(python_files_outside_the_pattern(["test_a.py", "check_a.py"], echoed), ["test_a.py"], "an echoed pattern was counted as the pattern of the step")
        skipped = "    steps:\n      - if: ${{ false }}\n        run: python3 -m unittest discover -s tests -p 'test_*.py'\n"
        self.assertEqual(python_files_outside_the_pattern(["test_a.py"], skipped), ["test_a.py"], "a discovery step that never runs was counted")
        self.assertEqual(python_files_outside_the_pattern(["sub/test_a.py"], "    steps:\n      - run: python3 -m unittest discover -s tests -p 'test_*.py'\n"), [], "a pattern was matched against the path and not the name of the file")

    def test_a_python_test_in_a_directory_without_an_init_is_reported_because_discover_does_not_enter_it(self) -> None:
        packages = {Path("package")}
        self.assertEqual(python_files_outside_a_package(["test_top.py", "plain/test_a.py", "package/test_b.py", "package/inner/test_c.py"], lambda directory: directory in packages),
                         ["plain/test_a.py", "package/inner/test_c.py"], "a file in a directory without __init__.py was not reported, or one in a package was")


if __name__ == "__main__":
    unittest.main()
