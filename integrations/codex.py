#!/usr/bin/env python3
"""Codex's adapter. Codex runs this for each hook event that integrations/codex-hooks.json names, sending the event as
JSON on stdin and reading the reply from stdout. Codex's hooks speak the engine's protocol as it stands, so this hands
the event to the engine unchanged.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "engine"

if __name__ == "__main__":
    assert (ENGINE / "engine.py").is_file(), f"no engine at {ENGINE}; install the plugin with its engine directory"
    # The engine imports its sibling modules by name, so its directory goes on the path before it loads.
    sys.path.insert(0, str(ENGINE))
    os.environ["OVERWATCH_DAEMON"] = "1"
    importlib.import_module("engine").main()
