"""Execute the scenarios that also generate the behavior documentation."""
import unittest

from acceptance.catalog import SCENARIOS
from acceptance.runner import scenario_suite


def load_tests(_loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: str | None) -> unittest.TestSuite:
    """unittest's load_tests protocol: adds every implemented catalog scenario to the tests found in this module."""
    found = tests.countTestCases()
    scenarios = scenario_suite(SCENARIOS)
    assert scenarios.countTestCases() > 0, f"the catalog gave {scenarios.countTestCases()} runnable scenarios; implement at least one in tests/acceptance/catalog.py"
    tests.addTests(scenarios)
    assert tests.countTestCases() == found + scenarios.countTestCases(), f"{tests.countTestCases()} tests after adding {scenarios.countTestCases()} scenarios to {found}; addTests dropped some"
    return tests
