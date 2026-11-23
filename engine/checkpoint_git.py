"""Running git for the checkpoint: the command runner, the error every git failure raises, and the repository root.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

GIT_TIMEOUT = 30

GIT_LOCATION_VARIABLES = frozenset({"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"})


class CheckpointError(Exception):
    """A git operation of the checkpoint failed or was refused; the message says why and what was left as it was."""


class GitExited(CheckpointError):
    """Git ran the command and it exited with an error, so the command is known to have ended; any other CheckpointError of a command leaves it unknown whether it ended. returncode is the exit code and output what git printed."""

    def __init__(self, message: str, returncode: int, output: str) -> None:
        assert returncode != 0, f"git exited with {returncode}, which is no error to raise"
        assert message, "a git command that exited with an error gave no message"
        super().__init__(message)
        self.returncode = returncode
        self.output = output



@dataclass(frozen=True)
class GitIO:
    """What a git command reads besides its arguments: the text on its standard input, and the index file it uses in
    place of the repository's own, and variables it needs besides the process's."""
    stdin: str | None = None
    index: Path | None = None
    environment: tuple[tuple[str, str], ...] = ()



def run_git(cwd: Path, argv: list[str], *, warnings_fail: bool = False, io: GitIO = GitIO()) -> str:
    """Runs git with argv in cwd and returns what it printed, or raises CheckpointError with git's own message. Bytes
    that are not UTF-8, as in a file name Linux allows, come back as the surrogate characters that encode them again,
    and a carriage return comes back as one: no line ending is translated, so a line break is only a line feed.
    Git finds the repository from cwd alone, whatever location variables the environment holds. With warnings_fail, a
    command that exits 0 but wrote to stderr, as git does for a directory it cannot read, fails too. io gives it
    input and an index file of its own."""
    environment = {name: value for name, value in os.environ.items() if name not in GIT_LOCATION_VARIABLES}
    assert not GIT_LOCATION_VARIABLES & set(environment), f"git's environment still names a repository: {GIT_LOCATION_VARIABLES & set(environment)}"
    environment.update(io.environment)
    if io.index is not None:
        environment["GIT_INDEX_FILE"] = str(io.index)
    command = " ".join(argv)
    try:
        result = subprocess.run(["git", *argv], cwd=cwd, env=environment, capture_output=True, timeout=GIT_TIMEOUT, check=False,
                                input=None if io.stdin is None else io.stdin.encode(errors="surrogateescape"))
    except (OSError, subprocess.SubprocessError) as error:
        raise CheckpointError(f"git {command} could not run in {cwd}: {error}; check that git is installed") from error
    stdout = result.stdout.decode(errors="surrogateescape")
    stderr = result.stderr.decode(errors="surrogateescape").strip()
    if result.returncode != 0:
        raise GitExited(f"git {command} failed in {cwd}: {stderr or stdout.strip() or f'exit {result.returncode}'}", result.returncode, stderr + stdout)
    if warnings_fail and stderr:
        raise CheckpointError(f"git {command} warned in {cwd}: {stderr}")
    assert result.returncode == 0, f"git {argv} exited {result.returncode} but was not reported; raise CheckpointError"
    assert isinstance(stdout, str), f"git {argv} printed {type(stdout)}, not text"
    return stdout


def repository_root(cwd: Path) -> Path:
    """The top directory of the repository holding cwd, which every command here runs in so that none of them
    sees only a subdirectory. Raises CheckpointError outside a repository."""
    root = Path(run_git(cwd, ["rev-parse", "--show-toplevel"]).strip())
    assert root.is_absolute(), f"git gave the relative top directory {root} for {cwd}; expected an absolute path"
    assert root.resolve() == cwd.resolve() or root.resolve() in cwd.resolve().parents, f"{root} does not hold {cwd}"
    return root
