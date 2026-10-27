"""Verify the executable acceptance scenarios, then generate or check their docs."""
from __future__ import annotations

import argparse
import inspect
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://github.com/benomahony/overwatch/blob/main"
sys.path.insert(0, str(ROOT / "tests"))

from acceptance.catalog import SCENARIOS  # noqa: E402
from acceptance.dsl import Scenario, Step  # noqa: E402
from acceptance.runner import scenario_suite  # noqa: E402

class BehaviorDocument:
    """An output boundary confined to one filename beneath its trusted directory."""
    def __init__(self, directory: Path) -> None:
        self.directory = directory.resolve()

    def path(self) -> Path:
        target = (self.directory / "behavior.md").resolve()
        target.relative_to(self.directory)
        return target

    def read(self) -> str:
        target = self.path()
        return target.read_text() if target.exists() else ""

    def write(self, text: str) -> None:
        self.path().write_text(text)


def source_link(path: Path, line: int) -> str:
    return f"{SOURCE}/{path.resolve().relative_to(ROOT).as_posix()}#L{line}"


def scenario_link(scenario: Scenario) -> str | None:
    catalog = ROOT / "tests" / "acceptance" / "catalog.py"
    lines = catalog.read_text().splitlines()
    line = next((number for number, text in enumerate(lines, 1) if f'Scenario("{scenario.title}"' in text), None)
    return None if line is None else source_link(catalog, line)


def step_text(step: Step) -> str:
    if step.action is None:
        return step.text
    path = Path(inspect.getsourcefile(step.action) or "")
    return f"[{step.text}]({source_link(path, inspect.getsourcelines(step.action)[1])})"


def render_scenarios(scenarios: tuple[Scenario, ...]) -> str:
    lines = ["# How Overwatch behaves", "",
             "Generated from the executable scenarios in `tests/acceptance/catalog.py`.",
             "Run `python3 scripts/scenarios.py` to verify the scenarios and regenerate this page.", ""]
    for status, title in (("implemented", "Verified behavior"), ("proposed", "Proposed behavior (not implemented)")):
        lines.extend([f"## {title}", ""])
        for scenario in scenarios:
            scenario.validate()
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
    return "\n".join(lines).rstrip() + "\n"


def publish_scenarios(scenarios: tuple[Scenario, ...], check: bool = False,
                      document: BehaviorDocument | None = None) -> int:
    result = unittest.TextTestRunner(stream=sys.stderr).run(scenario_suite(scenarios))
    if not result.wasSuccessful():
        return 1
    document = document or BehaviorDocument(ROOT / "docs")
    rendered = render_scenarios(scenarios)
    if check:
        existing = document.read()
        if existing != rendered:
            print(f"{document.path()} is out of date; run python3 scripts/scenarios.py", file=sys.stderr)
            return 1
    else:
        document.write(rendered)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Run the scenarios and reject stale docs without rewriting them")
    args = parser.parse_args()
    return publish_scenarios(SCENARIOS, args.check)


if __name__ == "__main__":
    raise SystemExit(main())
