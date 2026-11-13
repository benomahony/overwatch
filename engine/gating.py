"""Project policy for completion and explicitly protected tool actions."""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from typing import Any

INHERITED = ("allow", "block")


class PolicyError(ValueError):
    """The gate in .overwatch.json is malformed; the message names the field and what to change."""


@dataclass(frozen=True)
class ProtectedAction:
    """One parsed gate.protected_actions entry: the tool it guards, an optional pattern its command must match, and
    the checks that guard it, where none means every check."""
    tool: str
    command: re.Pattern[str] | None
    checks: tuple[str, ...]


def parse_action(action: object) -> ProtectedAction:
    """Parses one gate.protected_actions entry, raising PolicyError that names the field to fix."""
    if not isinstance(action, dict):
        raise PolicyError(f"gate.protected_actions entry {action} must be an object with a tool; fix it in .overwatch.json")
    tool, checks, pattern = action.get("tool"), action.get("checks", []), action.get("command")
    if not isinstance(tool, str) or not tool:
        raise PolicyError(f"a protected action must name a tool, not {tool}; set its tool in .overwatch.json")
    if not isinstance(checks, list) or not all(isinstance(name, str) and name for name in checks):
        raise PolicyError(f"{tool}'s checks must be an array of check names, not {checks}; fix them in .overwatch.json")
    if pattern is not None and not isinstance(pattern, str):
        raise PolicyError(f"{tool}'s command must be a regular expression string, not {pattern}; fix it in .overwatch.json")
    try:
        command = None if pattern is None else re.compile(pattern)
    except re.error as error:
        raise PolicyError(f"{tool}'s command {pattern} is not a valid regular expression ({error}); fix it in .overwatch.json") from error
    parsed = ProtectedAction(tool, command, tuple(checks))
    assert parsed.tool == tool and len(parsed.checks) == len(checks), f"parsed {parsed} lost part of the {tool} action"
    assert (parsed.command is None) == (pattern is None), f"{tool}'s command {pattern} parsed to {parsed.command}"
    return parsed


@dataclass(frozen=True)
class Gate:
    """A project's parsed gate: whether inherited failures block, and the protected actions. Only read_gate builds
    one, after checking the whole gate object."""
    inherited: str
    actions: tuple[ProtectedAction, ...]


def read_gate(override: dict[str, Any]) -> Gate:
    """Parses the gate object of a project's .overwatch.json. Raises PolicyError naming the field to fix."""
    policy = override.get("gate", {})
    if not isinstance(policy, dict):
        raise PolicyError(f"gate must be an object, not {policy}; fix it in .overwatch.json")
    inherited, entries = policy.get("inherited", "allow"), policy.get("protected_actions", [])
    if inherited not in INHERITED:
        raise PolicyError(f"gate.inherited must be one of {INHERITED}, not {inherited}; fix it in .overwatch.json")
    if not isinstance(entries, list):
        raise PolicyError(f"gate.protected_actions must be an array, not {entries}; fix it in .overwatch.json")
    gate = Gate(inherited, tuple(parse_action(entry) for entry in entries))
    assert gate.inherited in INHERITED, f"gate was built with inherited {gate.inherited}; read_gate must check it first"
    assert all(type(action) is ProtectedAction for action in gate.actions), f"gate holds {gate.actions}; parse_action must build each one"
    return gate


def tool_command(arguments: object) -> str:
    """The command a tool call runs, from its command or cmd argument: a string as given, or an argument list quoted
    with shlex.join so each argument keeps its boundaries; any other value means no command."""
    command = arguments.get("command", arguments.get("cmd", "")) if isinstance(arguments, dict) else ""
    if isinstance(command, list) and all(isinstance(part, str) for part in command):
        text = shlex.join(command)
        assert shlex.split(text) == command, f"quoting {command} gave {text}, which splits differently; fix tool_command's quoting"
    else:
        text = command if isinstance(command, str) else ""
    assert text in ("", command) or isinstance(command, list), f"tool_command turned {command} into {text}; it may only quote lists"
    return text


# One shell token: an operator (&&, ||, ;, &, |, parentheses, a new line or a backtick), or a word made of plain
# characters and quoted parts. A quote that never closes matches nothing and is skipped.
SHELL_TOKEN = re.compile(r"""[ \t\r]*(?:(&&|\|\||[;&|()\n`])|((?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^ \t\r\n;&|()`'"\\])+))""")
QUOTED_PART = re.compile(r"""'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)""")
ESCAPED_CHARACTER = re.compile(r"\\(.)")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
SHELLS = frozenset({"bash", "dash", "ksh", "sh", "zsh"})
# Words that run the command after them, so the command after them is the one that matters.
WRAPPERS = frozenset({"command", "env", "exec", "nohup", "sudo", "time"})
# Shell control words, which can stand before a command: if git merge x; then git commit; fi
CONTROL_WORDS = frozenset({"!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for", "if", "in", "then", "until", "while"})
# Git subcommands that can bring files into the workspace from somewhere other than the agent's own edits.
FILE_BRINGING = frozenset({"am", "apply", "checkout", "cherry-pick", "merge", "pull", "read-tree", "rebase", "reset",
                           "restore", "revert", "stash", "submodule", "switch"})
# The same for the GitHub CLI, whose subcommands come in pairs.
GH_FILE_BRINGING = frozenset({"pr checkout", "pr merge", "repo sync"})
# Git options that take the next word as their value, so it is not the subcommand.
GIT_VALUE_OPTIONS = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace"})
# How many levels of shell -c scripts, as in sh -c 'sh -c "git merge x"', are read for a git command.
QUOTE_DEPTH = 3


def unquoted(word: str) -> str:
    """word as the shell passes it on: its quotes removed and its backslashes dropped."""
    result = QUOTED_PART.sub(lambda found: found.group(1) if found.group(1) is not None
                             else ESCAPED_CHARACTER.sub(r"\1", found.group(2)) if found.group(2) is not None else found.group(3), word)
    assert "'" not in word or len(result) < len(word), f"{word!r} has quotes but unquoted left {result!r}; remove them"
    assert result == word or "\\" in word or "'" in word or '"' in word, f"{word!r} changed to {result!r} with nothing to unquote"
    return result


def shell_commands(text: str) -> list[list[str]]:
    """The simple commands in text, each as its words, split at the operators &&, ||, ;, &, |, parentheses, new
    lines and backticks, which are shell syntax only outside quotes. A quoted string stays one word."""
    commands: list[list[str]] = [[]]
    for found in SHELL_TOKEN.finditer(text):
        if found.group(1) is not None:
            commands.append([])
        else:
            commands[-1].append(unquoted(found.group(2)))
    kept = [words for words in commands if words]
    assert all(words for words in kept), f"commands {kept} include an empty one; drop empty commands"
    assert len(kept) <= len(text) + 1, f"{len(kept)} commands from {len(text)} characters; split each operator once"
    return kept


def is_prefix(word: str) -> bool:
    """Whether word stands before the command that runs: a VAR=value assignment, a wrapper such as env or sudo, or a
    shell control word such as if, then, do or !."""
    prefix = bool(ASSIGNMENT.match(word)) or word in WRAPPERS or word in CONTROL_WORDS
    assert not prefix or word != "", f"the empty word {word!r} counted as a prefix ({prefix}); skip empty words before asking"
    assert not prefix or bool(ASSIGNMENT.match(word)) or word in WRAPPERS | CONTROL_WORDS, f"{word!r} counted as a prefix of no kind"
    return prefix


def command_start(words: list[str]) -> int:
    """The index in words of the command that runs: past leading VAR=value assignments, wrappers such as env or sudo,
    and shell control words such as if, then, do or !."""
    index = 0
    while index < len(words) and is_prefix(words[index]):
        index += 1
    rest = words[index:]
    assert 0 <= index <= len(words), f"index {index} is outside the {len(words)} words; stop at the end"
    assert not rest or not is_prefix(rest[0]), f"{rest[:1]} is a prefix, not the command"
    return index


def shell_script(words: list[str]) -> str | None:
    """The script a shell command runs with -c, as in bash -lc 'git merge x'; None when words are no shell with -c."""
    script: str | None = None
    if words and words[0].rsplit("/", 1)[-1] in SHELLS:
        flagged = next((index for index, word in enumerate(words[1:], 1)
                        if word.startswith("-") and not word.startswith("--") and "c" in word), None)
        if flagged is not None and flagged + 1 < len(words):
            script = words[flagged + 1]
    assert script is None or words[0].rsplit("/", 1)[-1] in SHELLS, f"{words} gave script {script!r} without a shell"
    assert script is None or script in words, f"script {script!r} is not among the words {words}"
    return script


def git_subcommand(words: list[str]) -> str | None:
    """The git subcommand of the command words run: the first word after git that is no option and no option's
    value. None when they do not run git, or run it with no subcommand."""
    found: str | None = None
    if words and words[0].rsplit("/", 1)[-1] == "git":
        rest = iter(words[1:])
        for word in rest:
            if word in GIT_VALUE_OPTIONS:
                next(rest, None)
            elif word and not word.startswith("-"):
                found = word
                break
    assert found is None or words[0].rsplit("/", 1)[-1] == "git", f"found {found!r} in {words}, which do not run git"
    assert found is None or not found.startswith("-"), f"{found!r} is an option, not a subcommand; skip options"
    return found


def gh_subcommand(words: list[str]) -> str | None:
    """The first two non-option words after gh, as pr merge; None when words do not run gh."""
    found: str | None = None
    if words and words[0].rsplit("/", 1)[-1] == "gh":
        found = " ".join([word for word in words[1:] if not word.startswith("-")][:2])
    assert found is None or words[0].rsplit("/", 1)[-1] == "gh", f"found {found!r} in {words}, which do not run gh"
    assert found is None or len(found.split()) <= 2, f"{found!r} names more than two words"
    return found


def brings_in_files(command: str) -> bool:
    """Whether command runs a git or gh operation that can bring in files the agent did not write, as a merge, pull
    or cherry-pick can. Such a command may leave a plain commit in the reflog while the workspace holds another's
    changes. Only commands that run git or gh count, so a commit message that names a merge does not."""
    scripts = [command]
    found = False
    for _ in range(QUOTE_DEPTH):
        nested: list[str] = []
        for script in scripts:
            for words in shell_commands(script):
                words = words[command_start(words):]
                inner = shell_script(words)
                if inner is not None:
                    nested.append(inner)
                found = found or git_subcommand(words) in FILE_BRINGING or gh_subcommand(words) in GH_FILE_BRINGING
        scripts = nested
    assert isinstance(found, bool), f"{found!r} is not a yes or no; combine the checks with or"
    assert not found or command.strip() != "", f"the empty command {command!r} brought in files ({found}); read the commands first"
    return found


def protected_checks(tool: str, command: str, gate: Gate) -> list[str] | None:
    """The checks guarding a call of tool running command: None when no action protects it, an empty list when a
    protecting action names no checks and so means all of them. gate is a Gate, which only read_gate builds, so the
    project's policy has already been checked in full."""
    actions = gate.actions
    selected: set[str] = set()
    matched = [action for action in actions
               if action.tool.casefold() == tool.casefold() and (action.command is None or action.command.search(command))]
    for action in matched:
        if not action.checks:
            return []
        selected.update(action.checks)
    assert selected <= {name for action in actions for name in action.checks}, f"selected checks {selected} come from no action; fix protected_checks"
    assert bool(selected) == bool(matched), f"{len(matched)} matching actions selected {selected}; fix protected_checks"
    return sorted(selected) if matched else None
