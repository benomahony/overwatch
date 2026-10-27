"""Verify the executable acceptance scenarios, then generate or check their docs."""
from __future__ import annotations

import argparse
import importlib
import inspect
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://github.com/benomahony/overwatch/blob/main"
sys.path.insert(0, str(ROOT / "tests"))

catalog = importlib.import_module("acceptance.catalog")
dsl = importlib.import_module("acceptance.dsl")
runner = importlib.import_module("acceptance.runner")

class PublishError(Exception):
    """The guide was not published: its scenarios failed, or in check mode it is out of date. Says what to run."""


class BehaviorDocument:
    """The behavior guide, behavior.md, at one path inside the directory it is given, fixed when it is created."""
    NAME = "behavior.md"

    def __init__(self, directory: Path) -> None:
        """Resolves the guide's path once, so every later read and write acts on the same file checked here."""
        self.directory = directory.resolve()
        expected = self.directory / self.NAME
        self.target = expected.resolve()
        if self.target != expected:
            raise ValueError(f"{expected} resolves to {self.target}; remove the link so the guide stays in {self.directory}")
        assert self.directory.is_absolute(), f"guide directory {self.directory} is relative after resolve(); resolve it before joining"
        assert self.target.parent == self.directory, f"{self.target} is not directly inside {self.directory}; resolve the directory first"

    def read(self) -> str:
        """Returns the guide's text, or an empty string when it has not been generated yet."""
        assert self.target.parent == self.directory, f"guide target {self.target} moved out of {self.directory}; create a new BehaviorDocument"
        try:
            text = self.target.read_text()
        except FileNotFoundError:
            text = ""
        assert self.target.name == self.NAME, f"guide target {self.target} is not {self.NAME}; create a new BehaviorDocument"
        return text

    def write(self, text: str) -> None:
        """Replaces the guide at the target fixed in __init__ with text, then confirms the file holds exactly that."""
        assert text.endswith("\n"), f"guide text ends with {text[-20:]!r}; render_scenarios always ends it with a newline"
        self.target.write_text(text)
        assert self.target.read_text() == text, f"{self.target} does not hold what was just written; check the disk and rerun"


def source_link(path: Path, line: int) -> str:
    """Links to line of path, a file in this repository, on GitHub's main branch."""
    assert line >= 1, f"line {line} of {path} is not a line number; inspect counts from 1"
    link = f"{SOURCE}/{path.resolve().relative_to(ROOT).as_posix()}#L{line}"
    assert link.startswith(f"{SOURCE}/") and ".." not in link, f"{link} points outside the repository; pass a path under {ROOT}"
    return link


def scenario_link(scenario: dsl.Scenario) -> str | None:
    """Links to the line in the catalog that defines scenario, or None when its title is not written there literally."""
    source = ROOT / "tests" / "acceptance" / "catalog.py"
    lines = source.read_text().splitlines()
    line = next((number for number, text in enumerate(lines, 1) if f'Scenario("{scenario.title}"' in text), None)
    assert line is None or 1 <= line <= len(lines), f"{scenario.title!r} found at line {line} of {len(lines)}; count lines from 1"
    link = None if line is None else source_link(source, line)
    assert link is None or link.endswith(f"catalog.py#L{line}"), f"{scenario.title!r} links to {link}, not its line in {source.name}"
    return link


def step_text(step: dsl.Step) -> str:
    """The step's text, linked to the source of its action when it has one."""
    assert step.text.strip(), f"a {step.keyword} step has blank text; describe it in the catalog"
    if step.action is None:
        return step.text
    path = Path(inspect.getsourcefile(step.action) or "")
    text = f"[{step.text}]({source_link(path, inspect.getsourcelines(step.action)[1])})"
    assert text.startswith(f"[{step.text}]("), f"{step.keyword} step renders as {text!r}, which loses its text"
    return text


def render_scenarios(scenarios: tuple[dsl.Scenario, ...]) -> str:
    """Renders the behavior guide: verified scenarios, then proposed ones, each grouped by feature."""
    assert scenarios, f"no scenarios to render ({len(scenarios)}); pass SCENARIOS from tests/acceptance/catalog.py"
    for scenario in scenarios:
        scenario.validate()
    lines = ["# How Overwatch behaves", "",
             "Generated from the executable scenarios in `tests/acceptance/catalog.py`.",
             "Run `python3 scripts/scenarios.py` to verify the scenarios and regenerate this page.", ""]
    for status, title in (("implemented", "Verified behavior"), ("proposed", "Proposed behavior (not implemented)")):
        lines.extend([f"## {title}", ""])
        selected = [scenario for scenario in scenarios if scenario.status == status]
        for feature in dict.fromkeys(scenario.feature for scenario in selected):
            lines.extend([f"### {feature}", ""])
            for scenario in selected:
                if scenario.feature != feature:
                    continue
                lines.extend([f"#### {scenario.title}", "", f"Tags: {', '.join(scenario.tags)}."])
                link = scenario_link(scenario)
                if link:
                    lines.append(f"[{'View test' if status == 'implemented' else 'View proposal'}]({link})")
                lines.append("")
                lines.extend(f"- **{step.keyword}** {step_text(step)}." for step in scenario.steps)
                lines.append("")
    guide = "\n".join(lines).rstrip() + "\n"
    missing = [scenario.title for scenario in scenarios if f"#### {scenario.title}\n" not in guide]
    assert not missing, f"guide leaves out scenarios {missing}; check the feature grouping above"
    return guide


def publish_scenarios(scenarios: tuple[dsl.Scenario, ...], check: bool = False,
                      document: BehaviorDocument | None = None) -> None:
    """Runs the scenarios, then writes the guide, or with check compares it. Raises PublishError when either fails."""
    assert scenarios, f"no scenarios to publish ({len(scenarios)}); pass SCENARIOS from tests/acceptance/catalog.py"
    result = unittest.TextTestRunner(stream=sys.stderr).run(runner.scenario_suite(scenarios))
    document = document or BehaviorDocument(ROOT / "docs")
    if not result.wasSuccessful():
        raise PublishError(f"behavior scenarios failed, so {document.target} was left as it was; fix the failures above and rerun")
    rendered = render_scenarios(scenarios)
    if check:
        existing = document.read()
        if existing != rendered:
            raise PublishError(f"{document.target} is out of date; run python3 scripts/scenarios.py")
    else:
        document.write(rendered)
    assert document.read() == rendered, f"{document.target} differs from the rendered guide after a passing run; rerun python3 scripts/scenarios.py"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Run the scenarios and reject stale docs without rewriting them")
    args = parser.parse_args()
    assert catalog.SCENARIOS, "tests/acceptance/catalog.py defines no SCENARIOS; add at least one"
    try:
        publish_scenarios(catalog.SCENARIOS, args.check)
    except PublishError as error:
        print(error, file=sys.stderr)
        return 1
    assert BehaviorDocument(ROOT / "docs").read(), "docs/behavior.md is empty after publishing; rerun python3 scripts/scenarios.py"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
