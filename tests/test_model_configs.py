"""Keep the TLC configurations and the modules they check consistent: no checked name is undefined, and no TCR property goes unchecked.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

from paths import ROOT

SPEC = ROOT / "spec"
MODULE_OF = {"Overwatch": "Overwatch", "OverwatchTcr": "Overwatch", "OverwatchTcrReverts": "Overwatch", "IntegrationContract": "IntegrationContract",
             "IntegrationLifecycle": "IntegrationContract", "IntegrationNotices": "IntegrationContract"}
DEFINITION = re.compile(r"^([A-Za-z][A-Za-z0-9_]*)\s*==", re.MULTILINE)
CHECK_KEYWORDS = ("INVARIANTS", "PROPERTIES")
TCR_PROPERTIES_HEADING = "(* Section: TCR properties"
TCR_VARIABLES = ("tcr", "ck", "person", "settleDue", "noticePending", "noticeCause", "noticeTold")
TCR_CONFIGS = ("OverwatchTcr", "OverwatchTcrReverts")
MIN_VERSIONS_TO_REVERT_SEEN_WORK = 3
NOTICE_PROPERTIES = ("NoticesAreDeliveredOnce", "OnlyTcrHostsRaiseNotices", "NoticesOutliveRecovery", "PendingNoticesEventuallyResolve")


def checked_names(config: str) -> list[str]:
    """The invariants and properties a TLC configuration asks to check, in order."""
    names, listing = [], False
    for line in config.splitlines():
        if re.match(r"^[A-Z_]+\b", line):
            listing = line.strip() in CHECK_KEYWORDS
        elif listing and line.strip():
            names.append(line.strip())
    assert len(names) == len(set(names)), f"a name is checked twice in {names}; list it once"
    assert all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) for name in names), f"{names} holds something that is no operator name"
    return names


def constant(config: str, name: str) -> str:
    """The value a TLC configuration gives the constant called name."""
    found = re.search(rf"^\s*{name}\s*=\s*(.+?)\s*$", config, re.MULTILINE)
    assert found is not None, f"the configuration gives no value to {name}; add a line {name} = ..."
    assert found.group(1), f"{name} has an empty value"
    return found.group(1)


class ModelConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.configs = {name: (SPEC / f"{name}.cfg").read_text() for name in MODULE_OF}
        self.modules = {name: (SPEC / f"{name}.tla").read_text() for name in set(MODULE_OF.values())}
        found = sorted(path.stem for path in SPEC.glob("*.cfg"))
        assert found == sorted(MODULE_OF), f"spec/ holds the configurations {found}, not {sorted(MODULE_OF)}; list each one in MODULE_OF"
        assert all(self.modules.values()), f"a module of {sorted(self.modules)} is empty"

    def test_every_checked_name_is_defined_in_its_module(self) -> None:
        for config, module in MODULE_OF.items():
            defined = set(DEFINITION.findall(self.modules[module]))
            for name in checked_names(self.configs[config]):
                self.assertIn(name, defined, f"{config}.cfg checks {name}, which {module}.tla does not define")

    def test_a_revert_that_discards_seen_work_needs_three_versions_and_is_checked_with_them(self) -> None:
        deepest = max(int(constant(config, "MaxEdits")) for name, config in self.configs.items()
                      if "RevertNeverDiscardsSeenWork" in checked_names(config))
        self.assertGreaterEqual(deepest, MIN_VERSIONS_TO_REVERT_SEEN_WORK)

    def test_every_tcr_variable_is_read_by_a_property(self) -> None:
        source = self.modules["Overwatch"]
        properties = source[source.index(TCR_PROPERTIES_HEADING):]
        unread = [name for name in TCR_VARIABLES if not re.search(rf"\b{name}\b", properties)]
        self.assertEqual(unread, [], f"no TCR property reads {unread}; add one that does or drop the variable")

    def test_every_tcr_property_is_checked_by_some_tcr_configuration(self) -> None:
        source = self.modules["Overwatch"]
        defined = set(DEFINITION.findall(source[source.index(TCR_PROPERTIES_HEADING):]))
        checked = {name for config in TCR_CONFIGS for name in checked_names(self.configs[config])}
        self.assertEqual(sorted(defined - checked), [])

    def test_every_notice_property_of_the_contract_is_checked(self) -> None:
        defined = set(DEFINITION.findall(self.modules["IntegrationContract"]))
        self.assertEqual(sorted(set(NOTICE_PROPERTIES) - defined), [])
        self.assertEqual(sorted(set(NOTICE_PROPERTIES) - set(checked_names(self.configs["IntegrationNotices"]))), [])

    def test_only_the_tcr_configurations_turn_tcr_on(self) -> None:
        self.assertEqual(constant(self.configs["Overwatch"], "TcrMode"), "FALSE")
        for name in TCR_CONFIGS:
            self.assertEqual(constant(self.configs[name], "TcrMode"), "TRUE")
        for name in ("IntegrationContract", "IntegrationLifecycle"):
            self.assertEqual(constant(self.configs[name], "MaxNotices"), "0", f"{name}.cfg must keep its state space without notices")
        self.assertGreater(int(constant(self.configs["IntegrationNotices"], "MaxNotices")), 0)


if __name__ == "__main__":
    unittest.main()
