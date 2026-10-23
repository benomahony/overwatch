"""Execute the scenarios that also generate the behavior documentation."""
from acceptance.catalog import SCENARIOS
from acceptance.runner import scenario_suite


def load_tests(loader, tests, pattern):
    return scenario_suite(SCENARIOS)
