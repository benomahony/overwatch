"""Protect the link between executable behavior and published documentation."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest

from acceptance import catalog
from acceptance.dsl import Scenario
from acceptance.runner import scenario_suite
import paths
import scenarios

assert str(paths.ROOT / "scripts") in sys.path, f"{paths.ROOT / 'scripts'} is not on sys.path {sys.path}; paths puts scripts/ there so scenarios imports by name"


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
        assert self.document.target.parent == Path(temporary.name).resolve(), f"behavior document at {self.document.target} escaped {temporary.name}"
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

    def test_a_scenario_of_claude_code_in_tcr_mode_is_tagged_as_run_against_a_faked_host(self) -> None:
        faked = (Scenario("Claude Code in TCR mode", "Documentation", ("modes", "tcr", "claude"))
                 .given("A fixture is ready", lambda world: None).when("The operation runs", lambda world: None).then("The expected result holds", lambda world: None))
        plain = sample_scenario()
        rendered = scenarios.render_scenarios((faked, plain))
        self.assertEqual(rendered.count("faked-host"), 2)
        self.assertIn("Tags: modes, tcr, claude, faked-host.", rendered)
        self.assertNotIn("Tags: modes, tcr, claude.", rendered)

    def test_the_site_marks_a_faked_host_scenario_unverified_and_the_others_verified(self) -> None:
        spec = importlib.util.spec_from_file_location("docs_sync", paths.ROOT / "docs" / "sync.py")
        assert spec is not None and spec.loader is not None, "docs/sync.py cannot be loaded as a module"
        sync = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sync)
        body = ["### [Faked]($heading.id('faked'))", "", "Tags: tcr, faked-host.", "", "### [Plain]($heading.id('plain'))", "", "Tags: tcr.", ""]
        marked = sync.scenarios(body)
        self.assertIn(".attrs('unverified')", marked[0])
        self.assertIn(".attrs('verified')", marked[4])

    def test_the_guide_lists_a_scenario_that_runs_against_a_faked_host_under_a_heading_of_its_own_and_not_under_the_verified_ones(self) -> None:
        faked = (Scenario("Claude Code in TCR mode", "Documentation", ("modes", "tcr", "claude"))
                 .given("A fixture is ready", lambda world: None).when("The operation runs", lambda world: None).then("The expected result holds", lambda world: None))
        guide = scenarios.render_scenarios((faked, sample_scenario()))
        verified, others = guide.split("## Run against a faked host (not verified)")
        self.assertIn("#### Sample behavior", verified)
        self.assertNotIn("#### Claude Code in TCR mode", verified)
        self.assertIn("#### Claude Code in TCR mode", others)
        self.assertNotIn("#### Sample behavior", others)

    def test_a_faked_host_tags_line_that_marks_no_scenario_stops_the_site_from_marking_any(self) -> None:
        spec = importlib.util.spec_from_file_location("docs_sync", paths.ROOT / "docs" / "sync.py")
        assert spec is not None and spec.loader is not None, "docs/sync.py cannot be loaded as a module"
        sync = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sync)
        before_any_heading = ["Tags: tcr, faked-host.", "", "### [Plain]($heading.id('plain'))", "", "Tags: tcr.", ""]
        twice_in_one_scenario = ["### [Faked]($heading.id('faked'))", "", "Tags: tcr, faked-host.", "", "Tags: tcr, faked-host.", ""]
        for body in (before_any_heading, twice_in_one_scenario):
            with self.assertRaisesRegex(AssertionError, "tags lines name the faked host"):
                sync.unverified_headings(body)

    def test_duplicate_titles_cannot_hide_a_scenario(self) -> None:
        with self.assertRaisesRegex(ValueError, "unique"):
            scenario_suite((sample_scenario(), sample_scenario()))

    def test_failing_scenarios_do_not_overwrite_published_docs(self) -> None:
        scenario = (Scenario("Broken behavior", "Documentation")
                    .given("Setup is complete", lambda world: world.fail("deliberate failure"))
                    .when("The action runs", lambda world: None)
                    .then("An outcome is checked", lambda world: None))
        self.document.write("previously verified documentation\n")
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(scenarios.PublishError, "scenarios failed"):
                scenarios.publish_scenarios((scenario,), document=self.document)
        self.assertEqual(self.document.read(), "previously verified documentation\n")

    def test_check_mode_rejects_stale_docs_without_rewriting_them(self) -> None:
        scenario = sample_scenario()
        self.document.write("stale documentation\n")
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(scenarios.PublishError, "out of date"):
                scenarios.publish_scenarios((scenario,), check=True, document=self.document)
            self.assertEqual(self.document.read(), "stale documentation\n")
            scenarios.publish_scenarios((scenario,), document=self.document)
            scenarios.publish_scenarios((scenario,), check=True, document=self.document)
        self.assertEqual(self.document.read(), scenarios.render_scenarios((scenario,)))

    def test_a_feature_is_not_both_verified_and_proposed(self) -> None:
        verified = {scenario.feature for scenario in catalog.SCENARIOS if scenario.status == "implemented"}
        proposed = {scenario.feature for scenario in catalog.SCENARIOS if scenario.status == "proposed"}
        self.assertEqual(verified & proposed, set(), "a feature in both lists renders two sections with one heading id")

    def test_the_behaviour_form_must_offer_every_catalog_feature(self) -> None:
        form = "  - type: dropdown\n    id: feature\n    attributes:\n      options:\n        - {}\n        - A new feature\n    validations:\n"
        scenarios.check_form((sample_scenario(),), form.format("Documentation"))
        with self.assertRaisesRegex(scenarios.PublishError, "Feature dropdown"):
            scenarios.check_form((sample_scenario(),), form.format("Docs"))


if __name__ == "__main__":
    unittest.main()
