# overwatch

Watchers for agentic engineering. overwatch runs your project's tests beside Claude Code, Codex, OpenCode, Pi, or Neovim and hands failures back immediately, so the agent fixes what it broke before it moves on. The [site](https://benomahony.github.io/overwatch/) has this README as pages.

With Claude Code:

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

With Codex, overwatch runs the full suite when a session starts, checks again after tools change the workspace, and reports new failures after edits. Completion remains guarded until those failures clear, including during a Stop-hook continuation. Tools remain available for investigation and fixes. A change made outside Codex is picked up with the next prompt. Overwatch supplies transient status text while each check runs, though not every Codex surface renders it, and a concise visible warning for each distinct new failure, with full output saved to a log file. Existing failures form the session baseline, with a compact triage notice and full logs saved separately. They do not block Stop unless the inherited-finding policy requires it. Codex's status line does not currently accept persistent plugin-defined fields. Codex does not currently let a plugin start a new turn in an idle session, so that is the one difference from the Claude Code behavior above.

With OpenCode, overwatch checks the project at session start, before model calls, and after editing tools. OpenCode 1 appends a red report to the editing tool's result and warns if the session goes idle. OpenCode 2 also queues one correction pass when the session tries to settle while red.

With Pi, overwatch runs the full suite at session start, adds failures to editing tool results, keeps the latest failure in Pi's status line, and requests a correction pass whenever guarded failures remain at settlement.

With Neovim, the same long-running watchers put failures in the quickfix list and expose their latest result to status lines, with no agent involved.

Every integration runs the whole suite once to establish the session baseline. Existing failures remain visible in status and a triage inventory; only regressions against that baseline demand a correction.

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
| swift | `Package.swift` | `swift test` | none: reruns the full run after edits |

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

### Legacy-code triage

A legacy project can start with thousands of errors. Overwatch records the first result of each check as inherited backlog and sends one short notice with the inventory path. It saves all named issues and the full original output outside the conversation. Fixing that backlog is deliberate work; by default, it does not prevent ordinary tools or Stop events. New failures keep completion guarded, even if other errors were already present. Updating results never replaces the initial baseline with new failures.

Inspect a small batch from the inventory path in the notice:

```sh
python3 hooks/triage.py /path/from/notice.baseline.json --limit 20
python3 hooks/triage.py /path/from/notice.baseline.json --check go --match TestAdd --limit 10
python3 hooks/triage.py /path/from/notice.baseline.json --offset 20 --limit 20 --json
```

Run the script from your Overwatch checkout or use its installed absolute path. `--check` matches the check, command, or subproject; `--match` searches issue names, both without case sensitivity. The view groups by check and pages the initial snapshot, with links to full logs. It does not rerun checks or silently accept new regressions. When a runner does not name individual issues, the inventory contains its summary and full log instead. An increase in its reported error, warning, or failure counts is treated as a regression; a replacement issue with the same count cannot be distinguished without issue names.

### Failure gates and protected actions

Failure notifications and permission decisions are separate. Listing, searching, reading, editing, and running checks are ordinary operations: a red check does not deny them or launch a check before they run. Post-tool notifications never deny a tool. Completion stays guarded until the relevant failures clear; deduplicating a notification does not clear that gate. Warnings retain each check's existing failure policy, including Zanity warnings.

There are no protected tool actions by default. Configure specific actions in the repository's `.overwatch.json`:

```json
{
  "gate": {
    "inherited": "allow",
    "protected_actions": [
      { "tool": "Bash", "command": "\\bgit\\s+push\\b", "checks": ["zanity"] },
      { "tool": "Publish", "checks": ["zanity", "go"] }
    ]
  }
}
```

Tool names match without case sensitivity; use the tool name your agent sends, such as `Bash`, `bash`, or `exec_command`. An optional `command` regular expression matches its `command` or `cmd` argument. Use syntax supported by both Python and JavaScript. Protect the specific publication or deployment command rather than the whole shell tool, so repairs remain possible. Without `command`, the rule protects the entire named tool. `checks` selects watcher names or languages; an omitted or empty list selects all checks. An unrelated failed check does not block an action scoped to passing checks. Every protected attempt checks the failure state independently, so a prior denial does not grant the next attempt.

`inherited` defaults to `"allow"`, preserving backlog triage. Set it to `"block"` to require inherited findings to clear before completion or protected actions. Ordinary operations remain available under either policy. A successful check clears its gate; it does not clear failures from other checks. Environment errors retain their existing reporting behavior.

Command hooks use `PreToolUse` only for protected-action permission decisions and `Stop` for completion. Ordinary pre-tool hooks return an empty response without rerunning checks. Claude Code's in-process plugin denies protected tools before execution and replaces guarded completion with a correction request. OpenCode and Pi use their before-tool hooks for protected actions. Reload the plugin after updating hook definitions; Codex may require renewed hook trust.

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

The [behavior guide](https://benomahony.github.io/overwatch/behavior/) is generated from the Given/When/Then scenarios in [the acceptance catalog](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py). Each implemented step is executable against an isolated repository and the real command hook. Proposed scenarios are displayed separately and do not count as passing tests. Generation and CI checks run the implemented scenarios first; failing scenarios cannot publish a verified behavior page.

Add a scenario by composing `Scenario(...).given(...).when(...).then(...)` with fixture actions for every implemented step. Titles must be unique. Use `status="proposed"` with no executable actions for a planned behavior. Keep hook payloads, temporary paths, and test setup in the fixture rather than the prose.

```sh
python3 scripts/table.py      # after editing watchers.json
python3 scripts/scenarios.py  # verify scenarios and regenerate the behavior guide
python3 scripts/scenarios.py --check  # verify scenarios and reject stale behavior docs
python3 docs/sync.py          # regenerate site pages from README and the verified behavior guide
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_integrations.mjs
nvim --headless -l tests/overwatch_spec.lua
claude plugin validate .
claude plugin test .
claude --plugin-dir .
cd docs && zine                # the site, served locally
```
