"""The shapes of a read of bytes that the registry of reads does not find, which the README lists as its limit.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

EVASIONS = {
    "a reader named at run time": "def f(path, name):\n    return getattr(path, name)()\n",
    "a method caller": "import operator\ndef f(path):\n    return operator.methodcaller('read_text')(path)\n",
    "a library that decodes inside": "import tomllib\ndef f(path):\n    return tomllib.load(open(path, 'rb'))\n",
    "a process that decodes its output": "import subprocess\ndef f():\n    return subprocess.run(['ls'], capture_output=True, text=True).stdout\n",
    "a process that decodes its output by an encoding": "import subprocess\ndef f():\n    return subprocess.check_output(['ls'], encoding='utf-8')\n",
    "stdin given to map": "import sys\ndef f():\n    return list(map(str.strip, sys.stdin))\n",
    "stdin given to a library that reads it": "import csv, sys\ndef f():\n    return list(csv.reader(sys.stdin))\n",
    "stdin given to a function that iterates it": "import sys\ndef lines(stream):\n    return [line for line in stream]\ndef f():\n    return lines(sys.stdin)\n",
    "stdin joined into a text": "import sys\ndef f():\n    return ''.join(sys.stdin)\n",
    "an except clause that guards another call": "def f(path):\n    try:\n        int('1')\n    except ValueError:\n        pass\n    return path.read_text()\n",
}
