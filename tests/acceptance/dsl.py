"""A small executable vocabulary shared by acceptance tests and their docs."""
from __future__ import annotations

from dataclasses import dataclass, replace
from functools import partialmethod
from typing import Callable, Any


class CatalogError(ValueError):
    """A scenario in tests/acceptance/catalog.py is malformed; the message names it and what to change there."""


@dataclass(frozen=True)
class Step:
    keyword: str
    text: str
    action: Callable[[Any], None] | None = None


KEYWORDS = ("Given", "When", "Then", "And")


def validate_steps(title: str, steps: tuple[Step, ...]) -> None:
    """Walks the steps through Given, When and Then in that order, allowing And to continue the current phase.

    Raises CatalogError naming the scenario when a step comes out of order or the scenario never reaches Then."""
    transitions = {
        "start": {"Given": "given"},
        "given": {"Given": "given", "And": "given", "When": "when"},
        "when": {"When": "when", "And": "when", "Then": "then"},
        "then": {"Then": "then", "And": "then", "When": "when"},
    }
    phase = "start"
    for step in steps:
        following = transitions[phase].get(step.keyword)
        assert following is None or following in transitions, f"phase {phase!r} leads to unknown phase {following!r}; fix the transitions table"
        if following is None:
            raise CatalogError(f"{title}: {step.keyword} is out of order; reorder its steps as Given, When, Then in the catalog")
        phase = following
    if phase != "then":
        raise CatalogError(f"{title}: scenarios need Given, When, and Then steps; add the missing ones in the catalog")
    assert phase in transitions, f"{title!r} ended in unknown phase {phase!r}; fix the transitions table"


@dataclass(frozen=True)
class Scenario:
    title: str
    feature: str
    tags: tuple[str, ...] = ()
    status: str = "implemented"
    steps: tuple[Step, ...] = ()

    def step(self, keyword: str, text: str, action: Callable[[Any], None] | None = None) -> Scenario:
        """Returns a copy of this scenario with one more step; the scenario itself never changes."""
        assert keyword in KEYWORDS, f"step keyword {keyword!r} is not one of {KEYWORDS}; use given, when, then or and_"
        assert text.strip(), f"{self.title!r} has a blank {keyword} step; describe what it does"
        extended = replace(self, steps=(*self.steps, Step(keyword, text, action)))
        assert len(extended.steps) == len(self.steps) + 1, f"{self.title!r} has {len(extended.steps)} steps after adding one to {len(self.steps)}"
        return extended

    given = partialmethod(step, "Given")
    when = partialmethod(step, "When")
    then = partialmethod(step, "Then")
    and_ = partialmethod(step, "And")

    def validate(self) -> None:
        """Checks the scenario before it runs or is documented: a known status, steps in Given, When, Then order,
        and actions on every implemented step and none on a proposed one. Raises CatalogError naming what to change."""
        if not self.title.strip() or not self.feature.strip():
            raise CatalogError(f"scenario {self.title!r} in feature {self.feature!r} needs a title and a feature; fill both in the catalog")
        if self.status not in ("implemented", "proposed"):
            raise CatalogError(f"{self.title}: unknown status {self.status}; use implemented or proposed in the catalog")
        validate_steps(self.title, self.steps)
        first, last = self.steps[0].keyword, self.steps[-1].keyword
        assert first == "Given", f"{self.title!r} starts with {first}, which validate_steps should have refused; fix its transitions"
        assert last in ("Then", "And"), f"{self.title!r} ends with {last}, which validate_steps should have refused; fix its transitions"
        if self.status == "implemented" and any(not callable(step.action) for step in self.steps):
            raise CatalogError(f"{self.title}: every implemented step must have an executable action; add one or mark it proposed")
        if self.status == "proposed" and any(step.action is not None for step in self.steps):
            raise CatalogError(f"{self.title}: proposed scenarios cannot carry executable actions; drop them or mark it implemented")

    def execute(self, world: Any) -> None:
        """Validates the scenario, then runs each step's action against world in order, prefixing any failed
        assertion with the step that made it."""
        self.validate()
        if self.status != "implemented":
            raise CatalogError(f"{self.title}: proposed behavior cannot be executed or reported as verified; implement its steps first")
        ran = 0
        for step in self.steps:
            assert step.action is not None, f"{self.title!r} step {step.keyword} {step.text!r} has no action; validate should have caught it"
            try:
                step.action(world)
            except AssertionError as error:
                raise AssertionError(f"{step.keyword} {step.text}: {error}; fix the behavior under test or this step's check") from error
            ran += 1
        assert ran == len(self.steps), f"{self.title!r} ran {ran} of {len(self.steps)} steps; every step must run or fail"
