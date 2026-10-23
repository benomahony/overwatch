"""A small executable vocabulary shared by acceptance tests and their docs."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable, Any


@dataclass(frozen=True)
class Step:
    keyword: str
    text: str
    action: Callable[[Any], None] | None = None


def validate_steps(title: str, steps: tuple[Step, ...]) -> None:
    transitions = {
        "start": {"Given": "given"},
        "given": {"Given": "given", "And": "given", "When": "when"},
        "when": {"When": "when", "And": "when", "Then": "then"},
        "then": {"Then": "then", "And": "then", "When": "when"},
    }
    phase = "start"
    for step in steps:
        following = transitions[phase].get(step.keyword)
        if following is None:
            raise ValueError(f"{title}: {step.keyword} is out of order")
        phase = following
    if phase != "then":
        raise ValueError(f"{title}: scenarios need Given, When, and Then steps")


@dataclass(frozen=True)
class Scenario:
    title: str
    feature: str
    tags: tuple[str, ...] = ()
    status: str = "implemented"
    steps: tuple[Step, ...] = ()

    def step(self, keyword: str, text: str, action: Callable[[Any], None] | None) -> Scenario:
        return replace(self, steps=(*self.steps, Step(keyword, text, action)))

    def given(self, text: str, action: Callable[[Any], None] | None = None) -> Scenario:
        return self.step("Given", text, action)

    def when(self, text: str, action: Callable[[Any], None] | None = None) -> Scenario:
        return self.step("When", text, action)

    def then(self, text: str, action: Callable[[Any], None] | None = None) -> Scenario:
        return self.step("Then", text, action)

    def and_(self, text: str, action: Callable[[Any], None] | None = None) -> Scenario:
        return self.step("And", text, action)

    def validate(self) -> None:
        if self.status not in ("implemented", "proposed"):
            raise ValueError(f"Unknown scenario status: {self.status}")
        validate_steps(self.title, self.steps)
        if self.status == "implemented" and any(not callable(step.action) for step in self.steps):
            raise ValueError(f"{self.title}: every implemented step must have an executable action")
        if self.status == "proposed" and any(step.action is not None for step in self.steps):
            raise ValueError(f"{self.title}: proposed scenarios cannot carry executable actions")

    def execute(self, world: Any) -> None:
        self.validate()
        if self.status != "implemented":
            raise ValueError("Proposed behavior cannot be executed or reported as verified")
        for step in self.steps:
            assert step.action is not None
            try:
                step.action(world)
            except AssertionError as error:
                raise AssertionError(f"{step.keyword} {step.text}: {error}") from error
