# overwatch

Watchers for agentic engineering. overwatch runs your project's test watcher beside Claude Code and hands the agent every failing build the moment it happens, so it fixes what it broke before it moves on.

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

The watcher starts with an interactive session, survives `/clear`, and stops when the session ends.

## Watchers

| Project marker | Command |
| --- | --- |
| `build.zig` | `zig build -Doptimize=fast test --watch` |
| `pyproject.toml` | `uv run --with pytest --with pytest-watcher --with pytest-testmon ptw --now . --testmon` |

Add a language by adding an entry to `WATCHERS` in `hooks/watchers.ts`: its marker file, its command, the line that closes one build's report, and the pattern on that line that means it failed.

## Per-project override

`.claude/overwatch.json` in the project, every field optional:

```json
{
  "enabled": true,
  "argv": ["zig", "build", "test", "--watch"],
  "summary": "^Build Summary:.*$",
  "failed": "failed"
}
```

`"enabled": false` turns overwatch off for that project.

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
