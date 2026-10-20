# overwatch

Watchers for agentic engineering. overwatch runs your project's tests beside Codex, Claude Code, or Neovim and hands failures back immediately, so the agent fixes what it broke before it moves on.

With Codex, overwatch runs the full suite when a session starts, checks again after tools change the workspace, and prevents the turn from stopping while the latest result is red. A change made outside Codex is picked up with the next prompt. Overwatch supplies transient status text while each check runs, though not every Codex surface renders it, and a concise visible warning when one fails; the full report goes to the agent. Codex's status line does not currently accept persistent plugin-defined fields. Codex does not currently let a plugin start a new turn in an idle session, so that is the one difference from the Claude Code behavior below.

With Claude Code:

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

Before it starts watching, overwatch runs the whole suite once, so you see every test green (or the agent gets the failures) before any change is made.

The watcher starts with an interactive session, survives `/clear`, and stops when the session ends. Until one runs, overwatch looks again as each turn starts and completes, so a project scaffolded mid-session (`uv init`, `zig init`) is watched by its next turn at the latest. A watcher that exits is restarted at once, and the status line says so instead of keeping the last result; one that could not start, or exited within 30 seconds of starting, waits 30 seconds first, then 60. After three such quick exits in a row overwatch stops restarting it on its own and tries again only as turns start, at most every 30 seconds. The agent is told during a turn whenever the watcher exits, and woken with what the watcher last printed when overwatch gives up. Setting `"enabled": false` in `.overwatch.json` takes effect at the next check, with no restart.

## Watchers

| Language | Project marker | Full run first | Watcher |
| --- | --- | --- | --- |
| zig | `build.zig` | the watcher's first build | `zig build -Doptimize=fast test --watch` |
| python | `pyproject.toml` | `uv run --with pytest --with pytest-testmon pytest --testmon-noselect` | `uv run --with pytest --with pytest-watcher --with pytest-testmon ptw . --testmon` |
| js | `node_modules/.bin/vitest` | the watcher's first run | `npx --no -- vitest watch` |
| js | `node_modules/.bin/jest` | the watcher's first run | `npx --no -- jest --watchAll` |
| js | `bun.lock` or `bun.lockb` | the watcher's first run | `bun test --watch` |
| deno | `deno.json` or `deno.jsonc` | the watcher's first run | `deno test --watch` |
| go | `go.mod`, with `gotestsum` on `PATH` | `gotestsum -- ./...` | `gotestsum --watch` |
| go | `go.mod` | `go test ./...` | none: reruns the full run after edits |
| rust | `Cargo.toml` | `cargo test` | none: reruns the full run after edits |

Each language's rows are alternatives, tried in order: the first whose marker, and tool if it names one, is present runs. So a JS project runs the vitest or jest it has installed, ahead of `bun test`, and Go uses gotestsum's watcher when it is installed. A polyglot project runs a watcher for every language it has, side by side, each with its own part of the status line, for example `overwatch go ✗ 1 failed — TestAdd · overwatch rust ✓ passed`.

A command with no watcher of its own is read by its exit code, so a compile error fails it as surely as a failing test. Any full run that exits nonzero without printing its summary line counts as failed too, rather than going unreported. Colour codes are stripped before anything is read, since some tools (deno) print them even into a pipe.

When a build fails, overwatch names the failing tests (or compile errors, where the tool prints them on one line) at the top of the agent's report, and the first of them in the status line: `overwatch python ✗ 1 failed, 2 passed in 0.03s — tests/test_add.py::test_add`.

In every project, whatever its marker, zanity runs beside the test watcher whenever `zanity` is on `PATH`, as `zanity check . --watch --no-color` (zanity 0.1.12 or later). Any error or warning it reports counts as a failure, handed to the agent like a failing build, and the status line shows both results, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch zanity ✓ checked 12 files, no issues found.`. Codex runs the equivalent one-shot check after a change. Add another checker to `CHECKERS` in both `hooks/watchers.ts` and `hooks/codex.py`, its `marker` naming the executable to look for on `PATH`.

Add a language by adding an entry to `WATCHERS` in `hooks/watchers.ts`, `hooks/codex.py`, and `lua/overwatch/init.lua`: its marker file, its command, optionally a command that runs the whole suite once first, the line that closes one build's report, and the pattern on that line that means it failed. Optionally: `language`, to make it an alternative to the entries before it with the same one; `requires`, an executable that must be on `PATH`; `result`, the line to show when the build's result comes before the line that closes its report; and `failure`, a pattern matching each failing test, named by its first group that matched. An entry with no watch command may leave out the summary and be read by its exit code. When no baseline is configured, Codex runs the watch command through its first complete report and then stops it.

## Per-project override

`.overwatch.json` at the project root, every field optional. Codex, Claude Code, and Neovim all read it; `summary` and `failed` are JavaScript-style regexes, which the Neovim plugin translates.

```json
{
  "enabled": true,
  "argv": ["zig", "build", "test", "--watch"],
  "baseline": ["zig", "build", "test"],
  "summary": "^Build Summary:.*$",
  "failed": "failed"
}
```

`"enabled": false` turns overwatch off for that project, zanity included; `"baseline": []` skips the full run first. The other fields apply to one test watcher alone: in a polyglot project, the first language in the table above that the project has.

A project with no marker file is watched when its override names `summary`, `failed`, and `argv` or `baseline`; `name` labels it in the status line. With no `argv`, overwatch needs no watch tool: it reruns `baseline` itself after the agent's edits (Edit, Write, MultiEdit, NotebookEdit or Bash calls) go quiet. Edits made outside the session are picked up at the agent's next edit. This repository watches its own tests that way:

```json
{
  "name": "plugin",
  "baseline": ["claude", "plugin", "test", "."],
  "summary": "^ \\d+ fail$",
  "failed": "^[1-9]\\d* fail$"
}
```

## Install

### Codex

```sh
codex plugin marketplace add benomahony/overwatch
codex plugin add overwatch@overwatch
```

Restart Codex, run `/hooks`, and trust the Overwatch hooks. Codex requires renewed trust whenever a hook definition changes.

From a local checkout:

```sh
codex plugin marketplace add /absolute/path/to/overwatch
codex plugin add overwatch@overwatch
```

### Claude Code

```sh
/plugin install overwatch --marketplace benomahony/overwatch
```

From a local checkout:

```sh
claude plugin marketplace add ~/Code/open_source/overwatch
claude plugin install overwatch@overwatch
```

## Neovim

The same test watchers run beside Neovim (zanity does not; its own `zanity lsp` gives Neovim its findings on save): the full suite first, then the watcher, with no agent involved. The latest result of each language's watcher is in `require('overwatch').status()`, each failing build goes into the quickfix list (`:copen`), and a watcher with no `argv` reruns `baseline` after every save. It starts with Neovim in a project that has a watcher; `:OverwatchStart` and `:OverwatchStop` start and stop it.

```lua
vim.pack.add({ "https://github.com/benomahony/overwatch" })
require("lualine").setup({ sections = { lualine_x = { require("overwatch").status } } })
```

## Develop

```sh
python3 -m unittest tests.test_codex
nvim --headless -l tests/overwatch_spec.lua
claude plugin validate .
claude plugin test .
claude --plugin-dir .
nvim --headless -l tests/overwatch_spec.lua
```

### Model

`spec/Overwatch.tla` is a TLA+ model of `hooks/register.ts`, one action per step between `await`s, so TLC can try every order in which the session, the turn, the watcher processes and their timers can interleave. Each invariant at its end states one promise overwatch makes, and a violation comes back as the shortest sequence of events that breaks it. `LateAppendIsRead` says whether a message appended after the agent's last step is still read in that turn, which is up to Claude Code.

```sh
curl -sLO https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
java -cp tla2tools.jar tlc2.TLC -workers auto -metadir spec/states -config spec/Overwatch.cfg spec/Overwatch.tla
```
