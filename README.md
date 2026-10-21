# overwatch

Watchers for agentic engineering. overwatch runs your project's tests beside Claude Code, Codex, OpenCode, Pi, or Neovim and hands failures back immediately, so the agent fixes what it broke before it moves on. The [site](https://benomahony.github.io/overwatch/) has this README as pages.

With Claude Code:

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

With Codex, overwatch runs the full suite when a session starts, checks again after tools change the workspace, and prevents the turn from stopping while the latest result is red. A change made outside Codex is picked up with the next prompt. Overwatch supplies transient status text while each check runs, though not every Codex surface renders it, and a concise visible warning when one fails; the full report goes to the agent. Codex's status line does not currently accept persistent plugin-defined fields. Codex does not currently let a plugin start a new turn in an idle session, so that is the one difference from the Claude Code behavior above.

With OpenCode, overwatch checks the project at session start, before model calls, and after editing tools. OpenCode 1 appends a red report to the editing tool's result and warns if the session goes idle. OpenCode 2 also queues one correction pass when the session tries to settle while red.

With Pi, overwatch runs the full suite at session start, adds failures to editing tool results, keeps the latest failure in Pi's status line, and requests one more agent pass when the suite is still red at settlement.

With Neovim, the same long-running watchers put failures in the quickfix list and expose their latest result to status lines, with no agent involved.

Every integration runs the whole suite once before accepting the project's initial state, so you see every test green or the agent gets the failures before any change is made.

In Claude Code, the watcher starts with an interactive session, survives `/clear`, and stops when the session ends. overwatch looks for watchers again as each turn starts and completes, so a project scaffolded mid-session (`uv init`, `zig init`), or a sub-project added to one, is watched by its next turn at the latest. A watcher that exits is restarted at once, and the status line says so instead of keeping the last result; one that could not start, or exited within 30 seconds of starting, waits 30 seconds first, then 60. After three such quick exits in a row overwatch stops restarting it on its own and tries again only as turns start, at most every 30 seconds. The agent is told during a turn whenever the watcher exits, and woken with what the watcher last printed when overwatch gives up. Setting `"enabled": false` in `.overwatch.json` takes effect at the next check, with no restart.

## Watchers

| Language | Project marker | Full run first | Watcher |
| --- | --- | --- | --- |
| zig | `build.zig` | the watcher's first build | `zig build -Doptimize=fast test --watch` |
| python | `pyproject.toml`, with `uv` on `PATH` | `uv run --with pytest --with pytest-testmon pytest --testmon-noselect` | `uv run --with pytest --with pytest-watcher --with pytest-testmon ptw . --testmon` |
| python | `pyproject.toml`, with `pytest` on `PATH` | `pytest` | none: reruns the full run after edits |
| js | `node_modules/.bin/vitest` | the watcher's first run | `npx --no -- vitest watch` |
| js | `node_modules/.bin/jest` | the watcher's first run | `npx --no -- jest --watchAll` |
| js | `bun.lock` or `bun.lockb` | the watcher's first run | `bun test --watch` |
| deno | `deno.json` or `deno.jsonc` | the watcher's first run | `deno test --watch` |
| go | `go.mod`, with `gotestsum` on `PATH` | `gotestsum -- ./...` | `gotestsum --watch` |
| go | `go.mod` | `go test ./...` | none: reruns the full run after edits |
| rust | `Cargo.toml` | `cargo test` | none: reruns the full run after edits |

Each language's rows are alternatives, tried in order: the first whose marker, and tool if it names one, is present runs. So a JS project runs the vitest or jest it has installed, ahead of `bun test`, Go uses gotestsum's watcher when it is installed, and a Python project without uv runs the `pytest` on `PATH`. A polyglot project runs a watcher for every language it has, side by side, each with its own part of the status line, for example `overwatch go ✗ 1 failed: TestAdd · overwatch rust ✓ passed`.

A language the project's root lacks is looked for in its sub-projects, the folders up to two levels down, leaving out hidden ones and those `search` in `watchers.json` names (`node_modules`, `target`, `vendor`, `dist`, `build` and the like). Each folder that has the language gets a watcher of its own, run in that folder and named after it, `overwatch go services/api ✗ 1 failed: TestAdd`, unless a folder above it has it already. A language at the root covers the whole project, as a Cargo workspace or a JS monorepo with its runner installed at the root does.

A command with no watcher of its own is read by its exit code, so a compile error fails it as surely as a failing test. Any full run that exits nonzero without printing its summary line counts as failed too, rather than going unreported. Colour codes are stripped before anything is read, since some tools (deno) print them even into a pipe.

When a build fails, overwatch names the failing tests (or compile errors, where the tool prints them on one line, such as Rust's `error[E0308]: mismatched types`) at the top of the agent's report, and the first of them in the status line: `overwatch python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add`. A report longer than about 8,000 characters keeps its first quarter and the rest from its end, where cargo, go and pytest print what failed and why.

In every project, whatever its marker, zanity runs beside the test watcher whenever `zanity` is on `PATH`, as `zanity check . --watch --no-color` (zanity 0.1.12 or later). Any error or warning it reports counts as a failure, handed to the agent like a failing build, and the status line shows both results, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch zanity ✓ checked 12 files, no issues found.`. Codex, OpenCode, and Pi run the same command after a change, at the same time as each language's suite, and stop it after its first report. Add another checker to `checkers` in `watchers.json`, its `marker` naming the executable to look for on `PATH`.

Add a language by adding an entry to `watchers` in `watchers.json`, the one table every integration reads, then run `python3 scripts/table.py`, which copies it into `hooks/table.ts` for Claude Code (whose plugins cannot import JSON); the tests fail while the two differ. An entry names its marker file, its command, optionally a command that runs the whole suite once first, the line that closes one build's report, and the pattern on that line that means it failed. Optionally: `language`, to make it an alternative to the entries before it with the same one; `requires`, an executable that must be on `PATH`; `result`, the line to show when the build's result comes before the line that closes its report; and `failure`, a pattern matching each failing test, named by its first group that matched. An entry with no watch command may leave out the summary and be read by its exit code. Patterns are JavaScript regexes, written as JSON strings. When no baseline is configured, the short-lived agent integrations run the watch command through its first complete report and then stop it.

## Per-project override

`.overwatch.json` at the project root, every field optional. Claude Code, Codex, OpenCode, Pi, and Neovim all read it; `summary` and `failed` are JavaScript-style regexes, which the Neovim plugin translates.

```json
{
  "enabled": true,
  "argv": ["zig", "build", "test", "--watch"],
  "baseline": ["zig", "build", "test"],
  "summary": "^Build Summary:.*$",
  "failed": "failed"
}
```

`"enabled": false` turns overwatch off for that project, zanity included; `"baseline": []` skips the full run first. The other fields apply to one test watcher alone: in a polyglot project or a monorepo, the first language in the table above that the project has, at its root or in a sub-project. The override is read only at the project's root.

A project with no marker file is watched when its override names `summary`, `failed`, and `argv` or `baseline`; `name` labels it in the status line. With no `argv`, overwatch needs no watch tool: it reruns `baseline` itself after the agent's edits (Edit, Write, MultiEdit, NotebookEdit or Bash calls) go quiet. An edit made while the suite runs stops that run and starts another, so the agent never hears a result its later edits have already overtaken. Edits made outside the session are picked up at the agent's next edit. This repository watches its own tests that way:

```json
{
  "name": "plugin",
  "baseline": ["claude", "plugin", "test", "."],
  "summary": "^ \\d+ fail$",
  "failed": "^[1-9]\\d* fail$"
}
```

## Install

### Claude Code

```sh
/plugin install overwatch --marketplace benomahony/overwatch
```

From a local checkout:

```sh
claude plugin marketplace add ~/Code/open_source/overwatch
claude plugin install overwatch@overwatch
```

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

### OpenCode

```sh
opencode plugin github:benomahony/overwatch
```

OpenCode 2 uses its expanded plugin command:

```sh
opencode plugin add github:benomahony/overwatch
```

From a local checkout, add the checkout to `opencode.json` as a `plugin` entry in OpenCode 1 or a `plugins` entry in OpenCode 2.

### Pi

```sh
pi install git:github.com/benomahony/overwatch
```

From a local checkout:

```sh
pi install /absolute/path/to/overwatch
```

Pi asks you to trust project-local extensions before loading them. In non-interactive runs, pass `--approve` or save the trust decision.

### Neovim

```lua
vim.pack.add({ "https://github.com/benomahony/overwatch" })
```

The dedicated Neovim guide covers the quickfix list, status line, and commands.

## Neovim

The same test watchers run beside Neovim (zanity does not; its own `zanity lsp` gives Neovim its findings on save): the full suite first, then the watcher, with no agent involved. The latest result of each language's watcher is in `require('overwatch').status()`, every failing build goes into one quickfix list (`:copen`), titled with the watchers whose builds failed and cleared of each one as it goes green. A watcher with no `argv` reruns `baseline` after every save, stopping a run that a newer save has overtaken. A watcher that exits is restarted as it is in Claude Code, at once or after 30 and then 60 seconds; after three quick exits in a row it stays stopped, with what it last printed, until `:OverwatchStart`. It starts with Neovim in a project that has a watcher; `:OverwatchStart` and `:OverwatchStop` start and stop it.

```lua
vim.pack.add({ "https://github.com/benomahony/overwatch" })
require("lualine").setup({ sections = { lualine_x = { require("overwatch").status } } })
```

## Develop

```sh
python3 scripts/table.py      # after editing watchers.json
python3 docs/sync.py          # after editing this README: the site's pages come from it
python3 -m unittest tests.test_codex
node --test tests/test_integrations.mjs
nvim --headless -l tests/overwatch_spec.lua
claude plugin validate .
claude plugin test .
claude --plugin-dir .
cd docs && zine                # the site, served locally
```
