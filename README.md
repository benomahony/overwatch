# overwatch

Watchers for agentic engineering. overwatch runs your project's test watcher beside Claude Code and hands the agent every failing build the moment it happens, so it fixes what it broke before it moves on.

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

Before it starts watching, overwatch runs the whole suite once, so you see every test green (or the agent gets the failures) before any change is made.

The watcher starts with an interactive session, survives `/clear`, and stops when the session ends.

## Watchers

| Project marker | Full run first | Watcher |
| --- | --- | --- |
| `build.zig` | the watcher's first build | `zig build -Doptimize=fast test --watch` |
| `pyproject.toml` | `uv run --with pytest --with pytest-testmon pytest --testmon-noselect` | `uv run --with pytest --with pytest-watcher --with pytest-testmon ptw . --testmon` |

Add a language by adding an entry to `WATCHERS` in `hooks/watchers.ts`: its marker file, its command, optionally a command that runs the whole suite once first, the line that closes one build's report, and the pattern on that line that means it failed.

## Per-project override

`.claude/overwatch.json` in the project, every field optional:

```json
{
  "enabled": true,
  "argv": ["zig", "build", "test", "--watch"],
  "baseline": ["zig", "build", "test"],
  "summary": "^Build Summary:.*$",
  "failed": "failed"
}
```

`"enabled": false` turns overwatch off for that project; `"baseline": []` skips the full run first.

A project with no marker file is watched when its override names `argv`, `summary` and `failed`; `name` labels it in the status line. This repository watches its own tests with [entr](https://eradman.com/entrproject/):

```json
{
  "name": "plugin",
  "baseline": ["claude", "plugin", "test", "."],
  "argv": ["sh", "-c", "git ls-files -co --exclude-standard | entr -np claude plugin test ."],
  "summary": "^ \\d+ fail$",
  "failed": "^[1-9]\\d* fail$"
}
```

## Install

```
/plugin install overwatch --marketplace benomahony/overwatch
```

From a local checkout:

```
claude plugin marketplace add ~/Code/open_source/overwatch
claude plugin install overwatch@overwatch
```

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
