"""The checkpoint's guard against committing secrets and very large files: what it refuses, and how it reads the staged files.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import codecs
import os
import re
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

from checkpoint_git import CheckpointError, GitIO, run_git

# A staged file larger than this is refused: 50 MiB is where GitHub starts to warn about a file.
MAX_STAGED_BYTES = 50 * 1024 * 1024
ENV_TEMPLATES = frozenset({".env.example", ".env.sample", ".env.template"})
PRIVATE_KEY_NAMES = frozenset({"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"})
CREDENTIAL_NAMES = frozenset({"credentials", "credentials.json", "credentials.yml", "credentials.yaml"})
SECRET_FILE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".keystore")
SECRET_FILE_NAMES = frozenset({".npmrc", ".netrc", ".pgpass", ".git-credentials", "terraform.tfstate", "secrets.yml", "secrets.yaml", "kubeconfig"})
NAME_RULE = "name pattern"
UNREADABLE_RULE = "its added lines could not be read, so they were not screened for secrets"
SIZE_RULE = f"larger than {MAX_STAGED_BYTES // (1024 * 1024)} MiB"
# Only secrets that have an unmistakable form: a generic `key = "..."` pattern flagged too much ordinary code.
CONTENT_RULES = (
    ("AWS access key", r"AKIA[0-9A-Z]{16}"),
    ("private key", r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY"),
    ("GitHub token", r"gh[pousr]_[A-Za-z0-9]{36,}"),
    ("Slack token", r"xox[baprs]-"),
    ("Stripe live key", r"sk_live_"),
    ("Anthropic key", r"sk-ant-"),
    ("Google API key", r"AIza[0-9A-Za-z_-]{35}"),
)
CONTENT_PATTERN = re.compile("|".join(f"(?P<rule{index}>{pattern})" for index, (_, pattern) in enumerate(CONTENT_RULES)))
HUNK_HEADER = re.compile(r"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class Refused(CheckpointError):
    """The checkpoint would have committed files it must not: refusals lists each one. Nothing was committed, and the
    files stay in the work tree, unstaged."""

    def __init__(self, refusals: list[Refusal]) -> None:
        assert refusals, "a checkpoint was refused with nothing to refuse; raise Refused only for a refusal"
        self.refusals = refusals
        super().__init__(f"no checkpoint: it would commit {', '.join(refusal.text() for refusal in refusals)}; nothing was committed or reverted")
        assert self.refusals is refusals, "Refused lost the refusals it was made with"


class Unreadable(CheckpointError):
    """A diff of the staged files was not in the form this reader knows, so the lines it adds cannot be screened."""


@dataclass(frozen=True)
class Refusal:
    """One reason a checkpoint would not commit a file: the rule it broke, and the line of it when a line did."""
    path: str
    rule: str
    line: int | None = None

    def text(self) -> str:
        """The refusal as the agent and the user read it: `.env (name pattern)` or `src/a.py:12 (AWS access key)`."""
        place = self.path if self.line is None else f"{self.path}:{self.line}"
        assert self.path and self.rule, f"a refusal of {self.path!r} for {self.rule!r} names nothing; give both"
        assert self.line is None or self.line > 0, f"line {self.line} of {self.path} is no line number"
        return f"{place} ({self.rule})"


def name_rule(path: str) -> str | None:
    """NAME_RULE when the file's name says it holds secrets, as `.env`, a private key or a credentials file does;
    None for any other name, and for a template such as `.env.example` or a public key."""
    name = path.rsplit("/", 1)[-1].lower()
    if name in ENV_TEMPLATES or name.endswith(".pub"):
        return None
    private_key = any(name == key or name.startswith(f"{key}.") for key in PRIVATE_KEY_NAMES)
    secret = (name == ".env" or name.startswith(".env.") or name.endswith(SECRET_FILE_SUFFIXES) or name in SECRET_FILE_NAMES
              or private_key or name in CREDENTIAL_NAMES)
    assert not secret or not name.endswith(".pub"), f"{path} is a public key but was refused as a secret"
    assert not secret or name not in ENV_TEMPLATES, f"{path} is a template but was refused as a secret"
    return NAME_RULE if secret else None


def matches_path(parts: list[str], pattern: list[str]) -> bool:
    """Whether the path, split at its slashes, fits the pattern, split the same way: a part of the pattern is a glob for
    one part of the path, which a star does not cross, and a part that is two stars fits any number of parts."""
    reached, last = {0}, len(parts)
    for token in pattern:
        if token == "**":
            reached = {position for start in reached for position in range(start, last + 1)}
        else:
            reached = {position + 1 for position in reached if position < last and fnmatchcase(parts[position], token)}
    assert all(0 <= position <= last for position in reached), f"the pattern {pattern} reached a part beyond the path {parts}"
    assert not reached or min(reached) >= (0 if "**" in pattern else len(pattern)), f"the pattern {pattern} reached {reached} in {parts} without matching each part"
    return last in reached


def is_allowed(path: str, allow: tuple[str, ...]) -> bool:
    """Whether an allowlist entry names the file. An entry is a path from the repository's root, and a glob in it fits
    one directory or file name at a time; a name without a directory fits only that name at the root, and `**/` before
    it fits the name in any directory."""
    parts = path.split("/")
    allowed = any(matches_path(parts, entry.split("/")) for entry in allow)
    assert not allowed or allow, f"{path} is allowed by an empty allowlist"
    assert all(parts), f"{path!r} has an empty directory or file name to allow"
    return allowed


def staged_files(root: Path) -> list[tuple[str, str, str]]:
    """The mode, blob and path of each file the index adds or changes against HEAD, in git's order."""
    fields = run_git(root, ["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames", "--diff-filter=AMT"]).split("\0")
    assert fields[-1] == "", f"git ended its list of staged files with {fields[-1]!r}, not a NUL"
    headers, names = fields[:-1:2], fields[1:-1:2]
    assert len(headers) == len(names) and all(header.startswith(":") for header in headers), f"git listed headers and paths that do not pair up: {fields}"
    files = [(header.split()[1], header.split()[3], name) for header, name in zip(headers, names)]
    assert all(len(blob) >= 40 for _, blob, _ in files), f"git listed a blob that is no object ID in {files}"
    assert all(path for _, _, path in files), f"git listed a staged file with no path in {files}"
    return files


def oversized(root: Path, files: list[tuple[str, str, str]]) -> list[Refusal]:
    """The files among the staged ones, leaving out submodules, whose content is larger than MAX_STAGED_BYTES."""
    blobs = [(blob, path) for mode, blob, path in files if mode != "160000"]
    if not blobs:
        return []
    sizes = run_git(root, ["cat-file", "--batch-check=%(objectsize)"], io=GitIO(stdin="".join(f"{blob}\n" for blob, _ in blobs))).split()
    assert len(sizes) == len(blobs), f"git gave {len(sizes)} sizes for {len(blobs)} blobs"
    found = [Refusal(path, SIZE_RULE) for (_, path), size in zip(blobs, sizes) if size.isdigit() and int(size) > MAX_STAGED_BYTES]
    assert all(refusal.path in {path for _, path in blobs} for refusal in found), f"{found} name a file that was not staged"
    return found


def header_path(header: str) -> str:
    """The path that a `+++ b/path` header of a diff names. Git ends the header with a tab when the path holds a space,
    and writes a path with a quote or a control character between double quotes, with backslash escapes."""
    path = header.rstrip("\t")
    if path.startswith('"') and path.endswith('"') and len(path) > 1:
        path = codecs.escape_decode(path[1:-1].encode("utf-8"))[0].decode("utf-8", "surrogateescape")
    path = path.removeprefix("b/")
    assert path and not path.endswith("\t"), f"the header {header!r} names no path"
    assert not path.startswith("b/") or header.startswith('"'), f"the header {header!r} kept its b/ prefix"
    return path


def added_lines(diff: str) -> Iterator[tuple[str, int, str]]:
    """The path, the line number in the new file and the text of each line that a zero-context diff adds. A hunk header
    says how many old and new lines its hunk holds, so a line that begins like a file header is still a line. Raises
    Unreadable when the diff is not in a form this reader knows."""
    path, line, old_left, new_left = "", 0, 0, 0
    for text in diff.split("\n"):
        if old_left or new_left:
            if text.startswith("+"):
                yield path, line, text[1:]
                line, new_left = line + 1, new_left - 1
            elif text.startswith("-"):
                old_left -= 1
        elif text.startswith("+++ "):
            path = header_path(text[4:])
        elif text.startswith("@@"):
            header = HUNK_HEADER.match(text)
            if not header:
                raise Unreadable(f"git wrote the hunk header {text[:80]!r}, which the secrets guard does not know; the added lines were not screened")
            old_left, line, new_left = int(header.group(1) or 1), int(header.group(2)), int(header.group(3) or 1)
    if old_left or new_left:
        raise Unreadable(f"the diff ended inside a hunk, with {old_left} old and {new_left} new lines unread; the added lines were not screened")
    assert line >= 0, f"the diff gave the line number {line} for {path}, which is no line"
    assert path or line == 0, f"the diff added lines of a file it never named: {line} lines read"


def secret_lines(root: Path, skipped: set[str], unread: set[str] = frozenset()) -> list[Refusal]:
    """The first line of each file the index changes, apart from skipped, that adds a high-confidence secret, once for
    each kind of secret. Only the lines the edit adds are read, from one diff of the whole index, which leaves out the
    files in unread: they are too large to read. When the diff is not in a form this reader knows, every staged file
    that is not skipped or unread is refused as unscreened, since a secret may be in it."""
    exclusions = [f":(exclude,literal){path}" for path in sorted(unread)]
    diff = run_git(root, ["-c", "core.quotepath=false", "diff", "--cached", "--text", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
                          "--src-prefix=a/", "--dst-prefix=b/", "--no-renames", "--diff-filter=AMT", "--", ".", *exclusions])
    found: dict[tuple[str, str], int] = {}
    try:
        for path, line, text in added_lines(diff):
            hit = (CONTENT_PATTERN.search(text) or CONTENT_PATTERN.search(text.replace("\0", ""))) if path not in skipped else None
            if hit and hit.lastgroup:
                found.setdefault((path, CONTENT_RULES[int(hit.lastgroup.removeprefix("rule"))][0]), line)
    except Unreadable:
        return [Refusal(path, UNREADABLE_RULE) for _, _, path in staged_files(root) if path not in skipped and path not in unread]
    assert all(number > 0 for number in found.values()), f"a secret was found on line 0 of {found}"
    assert not {path for path, _ in found} & skipped, f"a skipped file was read for secrets: {found}"
    return [Refusal(path, rule, number) for (path, rule), number in found.items()]


def oversized_in_work_tree(root: Path) -> list[Refusal]:
    """The files that are changed or new in the work tree and larger than MAX_STAGED_BYTES, found from their sizes on disk
    before git reads any of them. A directory, a submodule and a file that vanished are no file of that size."""
    names = [name for name in run_git(root, ["ls-files", "--modified", "--others", "--exclude-standard", "-z"]).split("\0") if name]
    found = []
    for name in dict.fromkeys(names):
        try:
            status = os.lstat(root / name)
        except OSError:
            continue
        if stat.S_ISREG(status.st_mode) and status.st_size > MAX_STAGED_BYTES:
            found.append(Refusal(name, SIZE_RULE))
    assert all(refusal.rule == SIZE_RULE for refusal in found), f"{found} include a refusal that is no size refusal"
    assert len(found) <= len(set(names)), f"{len(found)} oversized files among {len(set(names))} changed ones"
    return found


def refusals(root: Path, allow: tuple[str, ...]) -> list[Refusal]:
    """Why the staged files in the repository at root must not be committed: a name that says secrets, a line that
    is a high-confidence secret, or a size over MAX_STAGED_BYTES. An allowlist entry skips the first two for the files
    it names, never the third."""
    files = staged_files(root)
    allowed = {path for _, _, path in files if is_allowed(path, allow)}
    named = [Refusal(path, NAME_RULE) for _, _, path in files if path not in allowed and name_rule(path)]
    large = oversized(root, files)
    contents = secret_lines(root, allowed | {refusal.path for refusal in named}, {refusal.path for refusal in large})
    found = [*named, *contents, *large]
    assert len({(refusal.path, refusal.rule, refusal.line) for refusal in found}) == len(found), f"a refusal is listed twice in {found}"
    assert not any(refusal.path in allowed and refusal.rule != SIZE_RULE for refusal in found), f"an allowed file is refused by name or content in {found}"
    return found
