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

A result that changes when the session has made no edit since the previous one comes from another process, such as a second agent or an editor working in the same tree. Claude Code, Codex, and OpenCode 2 say so in place of "failed after the latest change". Claude Code tells the agent at its next turn rather than waking it, and Claude Code and OpenCode 2 submit at most one correction for such changes however often they arrive. Completion stays guarded until the failure clears. Pi and OpenCode 1 check only after the session's own edits and at settlement, so they cannot tell such a change from the session's until then.

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

In a project whose branch tracks an upstream, the git checker runs beside them whenever `git` is on `PATH`. Every 60 seconds it fetches and lists the upstream commits the branch lacks, so on trunk the agent hears as soon as `main` moves, for example `overwatch git ✗ origin/main has 2 new commits; pull and rebase: 1084b40 Add the jest runner +1 more`. Each new commit is a failure of its own, so commits already upstream when the session starts are inherited and only those that land during it ask for a correction; pulling or rebasing moves HEAD, which takes a fresh baseline. A branch with no upstream, or a detached HEAD, passes with `no upstream to track`. Codex, OpenCode, and Pi fetch once after each change, like zanity. Set `OVERWATCH_GIT_INTERVAL` in its `env` to poll at another interval in seconds.

Add a language by adding an entry to `watchers` in `watchers.json`, the one table every integration reads, then run `python3 scripts/table.py`, which copies it into `hooks/table.ts` for Claude Code (whose plugins cannot import JSON); the tests fail while the two differ. An entry names its marker file, its command, optionally a command that runs the whole suite once first, the line that closes one build's report, and the pattern on that line that means it failed. Optionally: `language`, to make it an alternative to the entries before it with the same one; `requires`, an executable that must be on `PATH`; `result`, the line to show when the build's result comes before the line that closes its report; and `failure`, a pattern matching each failing test, named by every group that matched, joined by a space. An entry with no watch command may leave out the summary and be read by its exit code. Patterns are JavaScript regexes, written as JSON strings. Codex, OpenCode, and Pi keep each watch command running in one daemon per project, after its full suite when it has one, which starts again any that exits, and reads their reports once every watcher has been inactive for a second, with no output and no change in its processes or their CPU time, so each report covers the files as they were when the hook asked; one still working when its `timeout` passes reports `timeout`, as a check run directly does.

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

`watchers` configures any entry of `watchers.json` by its name, test watchers and checkers alike, in a polyglot project or a monorepo too, where a sub-project's watcher takes its entry's settings. Each takes `enabled`, `argv`, `baseline`, `summary`, `failed`, `env`, variables set for its commands over overwatch's own and merged over the entry's, `timeout`, the seconds a check may run before it reports `timeout`, 540 unless set, and `settle`, the seconds a watch command must stay inactive before Codex, OpenCode, and Pi take its latest report as covering the files, 1 unless set, for a tool that waits longer than that before it rebuilds; the top level takes `timeout` and `settle` too, for the project's own watcher. A check that times out has a new failure, never inherited, and holds completion and protected actions like any other. Codex, OpenCode, and Pi honour `timeout` today; Claude Code and Neovim accept it and do not yet time a check out. An entry turned off gives way to the next of its language, so turning off `vitest` runs `jest` or `bun` when the project has one. The top-level fields above apply after these. Codex, OpenCode, and Pi refuse a setting of the wrong type, or a field it does not take, and name it.

```json
{
  "watchers": {
    "git": { "env": { "OVERWATCH_GIT_INTERVAL": "300" } },
    "zanity": { "enabled": false },
    "python": { "baseline": ["uv", "run", "pytest", "-m", "not slow"] }
  }
}
```

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

A legacy project can start with thousands of errors. Overwatch records the first result of each check as inherited backlog and sends one short notice with the inventory path. It saves all named issues and the full original output outside the conversation. Fixing that backlog is deliberate work; by default, it does not prevent ordinary tools or Stop events. New failures keep completion guarded, even if other errors were already present. Updating results never replaces the initial baseline with new failures. In Claude Code, a pull or checkout that moves HEAD under the session brings in failures the agent did not make, so each check reruns and its next result becomes the baseline, unless the agent edits first. A commit keeps the baseline in every integration, even one made in the same step as an edit, since it records the workspace without changing it. Also in Claude Code, the first full run can still be going when the agent starts editing; edits made during it are rechecked once it ends, and that first result is no baseline, since it may hold those edits, so every failure it reports counts as new.

Inspect a small batch from the inventory path in the notice:

```sh
python3 engine/triage.py /path/from/notice.baseline.json --limit 20
python3 engine/triage.py /path/from/notice.baseline.json --check go --match TestAdd --limit 10
python3 engine/triage.py /path/from/notice.baseline.json --offset 20 --limit 20 --json
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

Command hooks use `PreToolUse` only for protected-action permission decisions and `Stop` for completion. Ordinary pre-tool hooks return an empty response without rerunning checks. Claude Code's in-process plugin denies protected tools before execution and replaces guarded completion with a correction request. It requests another correction for the same findings only after a tool call completes. Repeated completion attempts remain guarded without queuing duplicate corrections. Aborted or unsuccessful turns may settle. After interruption, automatic wakeups wait until another turn starts. Protected tools remain guarded. OpenCode and Pi use their before-tool hooks for protected actions. Reload the plugin after updating hook definitions; Codex may require renewed hook trust.

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

The [Spec page](https://benomahony.github.io/overwatch/model/) renders every TLA+ declaration and definition in source order, using the source's own sections and comments. The [Behavior page](https://benomahony.github.io/overwatch/behavior/#model-derived-integration-contracts) renders every host contract from the TLC fixtures and supports agent and text filters.

The [behavioral specification](https://github.com/benomahony/overwatch/blob/main/spec/README.md) covers every integration. `Overwatch.tla` models baselines, workspace versions, buffered builds, and notification ordering. `IntegrationContract.tla` specifies the six hosts' request/response behavior, independent inspection during checks, scoped guards, completion feedback, delivery, and lifecycle. Both layers share `FailurePolicy.tla`. Host differences are explicit: OpenCode 1 warns at idle, Pi continues, OpenCode 2 queues a correction, Codex and Claude guard completion, and Neovim has no agent gates.

TLC computes the expected observations for the result and host-contract replays; CI rejects stale generated fixtures. The replays exercise production hooks, native callbacks, real shared-checker processes, held session locks, and Neovim watcher callbacks. The spec documents the model bounds, composition assumptions, and each host's observable channels.

```sh
python3 scripts/table.py      # after editing watchers.json
python3 scripts/scenarios.py  # verify scenarios and regenerate the behavior guide
python3 scripts/scenarios.py --check  # verify scenarios and reject stale behavior docs
python3 docs/sync.py --write  # regenerate site pages from README and the verified behavior guide
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_integrations.mjs
node --test tests/test_model_integrations.mjs  # native integration callbacks with the real checker
node --test tests/test_integration_contract.mjs  # scoped guards, contention, delivery, and lifecycle
node --test tests/test_agents.mjs  # pi, opencode and codex against a scripted model; npm install --no-save @copilotkit/aimock first
nvim --headless -l tests/overwatch_spec.lua
nvim --headless -l tests/model_spec.lua  # model-derived stream replays
nvim --headless -l tests/integration_contract_spec.lua  # editor host contract
claude plugin validate .
claude plugin test .
claude --plugin-dir .
cd docs && zine                # the site, served locally
java -cp tla2tools.jar tlc2.TLC -metadir /tmp/tlc -config spec/Overwatch.cfg spec/Overwatch.tla  # model check the timing
python3 scripts/model_traces.py --jar /path/to/tla2tools.jar  # regenerate expectations after a model change
python3 scripts/model_traces.py --jar /path/to/tla2tools.jar --check  # reject stale expectations
python3 scripts/integration_traces.py --jar /path/to/tla2tools.jar  # regenerate all host contracts
python3 scripts/integration_traces.py --jar /path/to/tla2tools.jar --check
python3 scripts/spec_latex.py --jar /path/to/tla2tools.jar --check  # verify generated LaTeX downloads; needs pdflatex
python3 scripts/timing.py gaps    # fit the gaps between edits in your Claude Code transcripts
python3 scripts/timing.py budget --first 300  # longest rerun time for a 10% slowdown at each max-ahead
```
