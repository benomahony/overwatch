"""The generated Claude scenarios advance their fake clock in a bounded number of calls, each ending as a watcher
reports, judged without a clock from the advances in the source of each generated test. Measured, not explained: each
advance call costs about 500 ms of real time, or about 1000 ms when it ends between a report's quiet-wait judgement
and the next report."""
import ast
from pathlib import Path
import re
import tempfile
import unittest

from acceptance.catalog import SCENARIOS
from acceptance import runner
from paths import ROOT

ADVANCES_BUDGET = 5
"""The advances a generated test may make. Measured: a test of three advances ran in about 1200 ms, and each further
advance added about 500 ms."""
FIXTURE = ROOT / "tests" / "fixtures" / "gating.ts"
STEPS_FILE = ROOT / "tests" / "acceptance" / "claude_steps.py"
CATALOG_FILE = ROOT / "tests" / "acceptance" / "catalog.py"
WORLD_NAMES = ("World", "AcceptanceWorld")
QUIET_FILE = ROOT / "hooks" / "delivery.ts"
CONSTANT = re.compile(r"^(?:export )?const ([A-Z_]+) = ([A-Z_0-9+* ]+)$", re.MULTILINE)
ADVANCE = re.compile(r"clock\.advance\(([A-Z_0-9+* ]+)\)")
CLAUDE_TAG = "claude"
TEST = "test('Claude acceptance scenario "


def evaluate(expression: str, values: dict[str, int]) -> int:
    """The value of a sum of products of names and integers, such as `QUIET_MS + 50` or `2 * REPORT_MS`."""
    total = 0
    for term in expression.split("+"):
        product = 1
        for factor in term.split("*"):
            word = factor.strip().replace("_", "") if factor.strip()[0].isdigit() else factor.strip()
            product *= int(word) if word.isdigit() else values[word]
        total += product
    return total


def constants(files: tuple[Path, ...]) -> dict[str, int]:
    """The named integers the files declare, with each name that another declaration uses resolved."""
    found = {name: expression for file in files for name, expression in CONSTANT.findall(file.read_text())}
    values: dict[str, int] = {}
    while len(values) < len(found):
        before = len(values)
        for name, expression in found.items():
            if name not in values and all(word in values or re.fullmatch(r"[0-9_]+", word) for word in re.findall(r"[A-Z_0-9]+", expression)):
                values[name] = evaluate(expression, values)
        assert len(values) > before, f"constants {sorted(set(found) - set(values))} name something the files do not declare"
    return values


def claude_step_names() -> set[str]:
    """The names the class ClaudeSteps defines, read from the text of claude_steps.py, as methods or as assignments."""
    tree = ast.parse(STEPS_FILE.read_text())
    steps = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ClaudeSteps")
    defined = {node.name for node in steps.body if isinstance(node, ast.FunctionDef)}
    return defined | {target.id for node in steps.body if isinstance(node, ast.Assign) for target in node.targets if isinstance(target, ast.Name)}


def scenario_title(scenario: ast.expr) -> str:
    """The title, the first argument of the Scenario call at the root of a chain of steps."""
    call = next(node for node in ast.walk(scenario) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Scenario")
    return ast.literal_eval(call.args[0])


def scenario_actions(scenario: ast.expr) -> set[str]:
    """The names of the actions of a scenario's steps: every `World.name` under it, whatever the chain around it."""
    return {node.attr for node in ast.walk(scenario) if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in WORLD_NAMES}


def titles_with_claude_steps() -> set[str]:
    """The titles of the scenarios of catalog.py with a step whose action is a name of ClaudeSteps, read from the text
    of the catalog."""
    claude = claude_step_names()
    tree = ast.parse(CATALOG_FILE.read_text())
    catalog = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SCENARIOS" for target in node.targets))
    return {scenario_title(each) for each in catalog.elts if scenario_actions(each) & claude}


def claude_scenarios(scenarios) -> list:
    """The implemented scenarios that the catalog tags `claude`, which are those the scan takes to run Claude Code."""
    return [each for each in scenarios if each.status == "implemented" and CLAUDE_TAG in each.tags]


def generated_tests(scenarios: tuple) -> list[tuple[str, str, str]]:
    """The title, the fixture and the source of each generated Claude test, as `run_claude_scenario` writes them. The
    steps only build a transcript, so they run with the collector in place of `run_claude_scenario`, and no process starts."""
    found = []
    for scenario in claude_scenarios(scenarios):
        with tempfile.TemporaryDirectory() as directory:
            case = runner.ScenarioCase(scenario)
            case.fixture_root = Path(directory)
            sources: list[str] = []
            case.run_claude_scenario = lambda case=case, sources=sources: sources.append(case.claude_test_source())
            scenario.execute(case)
        assert sources, f"{scenario.title!r} is tagged {CLAUDE_TAG} but never calls run_claude_scenario, so it generates no test"
        for source in sources:
            for body in source.split(TEST)[1:]:
                found.append((scenario.title, "gating" if "gatingProject(" in source else "tcr", body))
    return found


def advances(body: str, names: dict[str, int]) -> list[int]:
    """The fake milliseconds of each advance of a generated test, its closing one included."""
    return [evaluate(expression, names) for expression in ADVANCE.findall(body)]


class ClaudeScenarioTimeTests(unittest.TestCase):
    tests: list[tuple[str, str, str]]
    names: dict[str, int]

    @classmethod
    def setUpClass(cls) -> None:
        cls.tests = generated_tests(SCENARIOS)
        cls.names = constants((QUIET_FILE, FIXTURE))

    def test_scan_covers_every_generated_claude_test(self) -> None:
        titles = {title for title, _, _ in self.tests}
        self.assertGreaterEqual(len(titles), 20, f"only {sorted(titles)} generate Claude tests")
        self.assertGreater(len(self.tests), len(titles), "no scenario splits into several tests, so the split by a fresh hook instance is not scanned")
        self.assertTrue(all(advances(body, self.names) for _, _, body in self.tests), "a generated test advances no clock, so it cannot be scanned")

    def test_each_test_makes_no_more_advances_than_the_budget(self) -> None:
        over = {title: len(advances(body, self.names)) for title, _, body in self.tests if len(advances(body, self.names)) > ADVANCES_BUDGET}
        self.assertEqual(over, {}, f"these tests make more than {ADVANCES_BUDGET} advances of about half a second each")

    def test_each_advance_of_a_watcher_test_ends_as_a_report_arrives(self) -> None:
        report = self.names.get("REPORT_MS")
        self.assertIsNotNone(report, "the watcher fixture names no REPORT_MS, the cadence its advances are whole numbers of")
        assert report is not None, f"REPORT_MS is {report}, though it was just found"
        off = {f"{title}: {advances(body, self.names)}": [each for each in advances(body, self.names) if each % report] for title, fixture, body in self.tests if fixture == "gating" and any(each % report for each in advances(body, self.names))}
        self.assertEqual(off, {}, f"an advance that is no whole number of {report} ms ends between a judgement and the next report, and the host then waits about a second of real time for it")


class ClaudeScenarioCoverageTests(unittest.TestCase):
    def test_the_claude_tag_names_exactly_the_scenarios_with_claude_steps(self) -> None:
        tagged = {each.title for each in claude_scenarios(SCENARIOS)}
        stepped = titles_with_claude_steps()
        self.assertEqual(tagged, stepped, f"tagged {CLAUDE_TAG} without Claude steps: {sorted(tagged - stepped)}; Claude steps without the tag, so the scan skips them: {sorted(stepped - tagged)}")


if __name__ == "__main__":
    unittest.main()
