"""What the tests of the notice cells share: a pairwise cover of axes of values, and the names a notice lists after a label.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import itertools
import re


def pairwise(axes: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
    """Rows that put every value of each axis beside every value of each other axis at least once, chosen greedily."""
    def pairs(row: tuple[object, ...]) -> set[tuple[tuple[int, object], tuple[int, object]]]:
        return {((i, row[i]), (j, row[j])) for i, j in itertools.combinations(range(len(row)), 2)}

    candidates = list(itertools.product(*axes))
    uncovered = set().union(*(pairs(row) for row in candidates))
    rows = []
    while uncovered:
        best = max(candidates, key=lambda row: len(pairs(row) & uncovered))
        rows.append(best)
        uncovered -= pairs(best)
    return rows


def names_after(told: str, label: str) -> list[str]:
    found = re.search(re.escape(label) + r" ((?:`[^`]+`(?:, )?)+)", told)
    return sorted(re.findall(r"`([^`]+)`", found.group(1))) if found else []
