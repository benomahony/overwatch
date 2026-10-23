"""Run implemented scenarios through the existing unittest framework."""
import unittest

from .dsl import Scenario
from .world import AcceptanceWorld


class ScenarioCase(AcceptanceWorld):
    def __init__(self, scenario: Scenario) -> None:
        super().__init__("runTest")
        self.scenario = scenario

    def shortDescription(self) -> str:
        return self.scenario.title

    def runTest(self) -> None:
        self.scenario.execute(self)


def scenario_suite(scenarios: tuple[Scenario, ...]) -> unittest.TestSuite:
    for scenario in scenarios:
        scenario.validate()
    titles = [scenario.title for scenario in scenarios]
    if len(titles) != len(set(titles)):
        raise ValueError("Acceptance scenario titles must be unique")
    return unittest.TestSuite(ScenarioCase(scenario) for scenario in scenarios if scenario.status == "implemented")
