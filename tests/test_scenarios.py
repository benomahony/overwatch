"""Protect the link between executable behavior and published documentation."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from acceptance.dsl import Scenario
from acceptance.runner import scenario_suite
from paths import ROOT
import scenarios


def sample_scenario() -> Scenario:
    """A minimal implemented scenario whose three steps do nothing, for tests about the catalog machinery itself."""
    scenario = (Scenario("Sample behavior", "Documentation")
                .given("A fixture is ready", lambda world: None)
                .when("The operation runs", lambda world: None)
                .then("The expected result holds", lambda world: None))
    keywords = [step.keyword for step in scenario.steps]
    assert keywords == ["Given", "When", "Then"], f"sample scenario has steps {keywords}; keep one Given, When and Then"
    assert scenario.status == "implemented", f"sample scenario is {scenario.status!r}; tests rely on it running"
    return scenario


class ScenarioContractTests(unittest.TestCase):
    def setUp(self) -> None:
        """Gives each test its own behavior document in a fresh temporary directory, removed after the test."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.document = scenarios.BehaviorDocument(Path(temporary.name))
        assert self.document.path().parent == Path(temporary.name).resolve(), f"behavior document at {self.document.path()} escaped {temporary.name}"
        assert self.document.read() == "", f"fresh behavior document already holds {self.document.read()!r}; tests need it empty"

    def test_implemented_steps_require_executable_bindings(self) -> None:
        scenario = Scenario("Unbound behavior", "Documentation").given("Setup").when("Action").then("Outcome")
        with self.assertRaisesRegex(ValueError, "executable action"):
            scenario.validate()

    def test_assertions_cannot_precede_the_action(self) -> None:
        scenario = Scenario("Out of order", "Documentation", status="proposed").given("Setup").then("Outcome").when("Action")
        with self.assertRaisesRegex(ValueError, "out of order"):
            scenario.validate()

    def test_failed_steps_abort_the_remaining_scenario(self) -> None:
        visited = []
        scenario = (Scenario("Failing action", "Documentation")
                    .given("Setup is complete", lambda world: visited.append("setup"))
                    .when("The action fails", lambda world: self.assertEqual(visited, []))
                    .then("This must not execute", lambda world: visited.append("assertion")))
        with self.assertRaisesRegex(AssertionError, "When The action fails"):
            scenario.execute(None)
        self.assertEqual(visited, ["setup"])

    def test_proposals_are_not_tests_or_verified_documentation(self) -> None:
        proposal = Scenario("Future behavior", "Planned", status="proposed").given("Setup").when("Action").then("Outcome")
        self.assertEqual(scenario_suite((proposal,)).countTestCases(), 0)
        rendered = scenarios.render_scenarios((sample_scenario(), proposal))
        verified, proposed = rendered.split("## Proposed behavior (not implemented)")
        self.assertNotIn("Future behavior", verified)
        self.assertIn("Future behavior", proposed)
        with self.assertRaisesRegex(ValueError, "cannot be executed"):
            proposal.execute(None)

    def test_duplicate_titles_cannot_hide_a_scenario(self) -> None:
        with self.assertRaisesRegex(ValueError, "unique"):
            scenario_suite((sample_scenario(), sample_scenario()))

    def test_failing_scenarios_do_not_overwrite_published_docs(self) -> None:
        scenario = (Scenario("Broken behavior", "Documentation")
                    .given("Setup is complete", lambda world: world.fail("deliberate failure"))
                    .when("The action runs", lambda world: None)
                    .then("An outcome is checked", lambda world: None))
        self.document.write("previously verified documentation")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(scenarios.publish_scenarios((scenario,), document=self.document), 1)
        self.assertEqual(self.document.read(), "previously verified documentation")

    def test_check_mode_rejects_stale_docs_without_rewriting_them(self) -> None:
        scenario = sample_scenario()
        self.document.write("stale documentation")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(scenarios.publish_scenarios((scenario,), check=True, document=self.document), 1)
            self.assertEqual(self.document.read(), "stale documentation")
            self.assertEqual(scenarios.publish_scenarios((scenario,), document=self.document), 0)
            self.assertEqual(scenarios.publish_scenarios((scenario,), check=True, document=self.document), 0)


if __name__ == "__main__":
    unittest.main()
