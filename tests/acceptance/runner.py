"""Run implemented scenarios through the existing unittest framework."""
import unittest

from .dsl import CatalogError, Scenario
from .world import AcceptanceWorld


class ScenarioCase(AcceptanceWorld):
    """One implemented scenario as a unittest case: the catalog builds Scenario values, scenario_suite wraps each
    in this case, and runTest drives its steps against the AcceptanceWorld fixture that setUp prepares."""

    def __init__(self, scenario: Scenario) -> None:
        """Holds the scenario for runTest; the fixture itself is built later by AcceptanceWorld.setUp."""
        assert scenario.status == "implemented", f"{scenario.title!r} is {scenario.status!r}, and only implemented scenarios run"
        assert scenario.steps, f"{scenario.title!r} has no steps, so it would pass without checking anything"
        super().__init__("runTest")
        self.scenario = scenario

    def shortDescription(self) -> str:
        title = self.scenario.title
        assert title, f"scenario in {self.scenario.feature!r} has an empty title, which unittest reports as its name"
        assert "\n" not in title, f"title {title!r} spans lines, but unittest prints it on one"
        return title

    def runTest(self) -> None:
        missing = [step.text for step in self.scenario.steps if not callable(step.action)]
        assert self.scenario.steps, f"{self.scenario.title!r} has no steps; add Given, When and Then steps in tests/acceptance/catalog.py"
        assert not missing, f"{self.scenario.title!r} has steps with no action: {missing}; give each one in tests/acceptance/catalog.py"
        self.scenario.execute(self)


def scenario_suite(scenarios: tuple[Scenario, ...]) -> unittest.TestSuite:
    """Validates the whole catalog, then returns a unittest suite of its implemented scenarios."""
    if not scenarios:
        raise CatalogError("No acceptance scenarios given; pass SCENARIOS from tests/acceptance/catalog.py")
    for scenario in scenarios:
        scenario.validate()
    titles = [scenario.title for scenario in scenarios]
    if len(titles) != len(set(titles)):
        repeated = sorted({title for title in titles if titles.count(title) > 1})
        raise CatalogError(f"Acceptance scenario titles must be unique; rename the repeated ones in tests/acceptance/catalog.py: {repeated}")
    suite = unittest.TestSuite(ScenarioCase(scenario) for scenario in scenarios if scenario.status == "implemented")
    implemented = sum(scenario.status == "implemented" for scenario in scenarios)
    assert suite.countTestCases() == implemented, f"suite runs {suite.countTestCases()} cases for {implemented} implemented scenarios; ScenarioCase must wrap each one"
    proposed = [case.scenario.title for case in suite if case.scenario.status != "implemented"]
    assert not proposed, f"proposed scenarios {proposed} reached the suite; filter them out before wrapping in ScenarioCase"
    return suite
