# overwatch

Watchers for agentic engineering.
overwatch runs your project's tests beside Claude Code, Codex, OpenCode, Pi, or Neovim and hands failures back immediately, so the agent fixes what it broke before it moves on.
The [site](https://benomahony.github.io/overwatch/) has this README as pages.

With Claude Code:

- **Idle session:** a failing build starts a turn with the failure.
- **Running turn:** the failure joins that turn, read at the agent's next step.
- **Back to green:** the agent is told during a turn; otherwise the status line shows it.
- The status line always shows the latest result, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed`.

With Codex, overwatch runs the full suite when a session starts, checks again after tools change the workspace, and reports new failures after edits.
Completion remains guarded until those failures clear, including during a Stop-hook continuation.
Tools remain available for investigation and fixes.
A change made outside Codex is picked up with the next prompt.
Overwatch supplies transient status text while each check runs, though not every Codex surface renders it, and a concise visible warning for each distinct new failure, with full output saved to a log file.
Existing failures form the session baseline, with a compact triage notice and full logs saved separately.
They do not block Stop unless the inherited-finding policy requires it.
Codex's status line does not currently accept persistent plugin-defined fields.
Codex does not currently let a plugin start a new turn in an idle session, so that is the one difference from the Claude Code behavior above.

With OpenCode, overwatch checks the project at session start, before model calls, and after editing tools.
OpenCode 1 appends a red report to the editing tool's result and warns if the session goes idle.
OpenCode 2 also queues one correction pass when the session tries to settle while red.
If OpenCode reports that prompt as failed, Overwatch asks again at the next idle; when the host had queued it before it reported the failure, as after a timeout, the agent reads the correction twice.

With Pi, overwatch runs the full suite at session start, adds failures to editing tool results, keeps the latest failure in Pi's status line, and requests a correction pass whenever guarded failures remain at settlement.

With Neovim, the same long-running watchers put failures in the quickfix list and expose their latest result to status lines, with no agent involved.

Every integration runs the whole suite once to establish the session baseline.
Existing failures remain visible in status and a triage inventory; only regressions against that baseline demand a correction.

A result that changes when the session has made no edit since the previous one comes from another process, such as a second agent or an editor working in the same tree.
Claude Code, Codex, and OpenCode 2 say so in place of "failed after the latest change".
Claude Code tells the agent at its next turn rather than waking it, and Claude Code and OpenCode 2 submit at most one correction for such changes however often they arrive.
Completion stays guarded until the failure clears.
Pi and OpenCode 1 check only after the session's own edits and at settlement, so they cannot tell such a change from the session's until then.

In Claude Code, the watcher starts with an interactive session, survives `/clear`, and stops when the session ends. overwatch looks for watchers again as each turn starts and completes, so a project scaffolded mid-session (`uv init`, `zig init`), or a sub-project added to one, is watched by its next turn at the latest.
A watcher that exits is restarted at once, and the status line says so instead of keeping the last result; one that could not start, or exited within 30 seconds of starting, waits 30 seconds first, then 60.
After three such quick exits in a row overwatch stops restarting it on its own and tries again only as turns start, at most every 30 seconds.
The agent is told whenever the watcher exits: during a turn at once, and when no turn runs, at the start of the next turn.
The agent is woken with what the watcher last printed when overwatch gives up.
It is not woken when the quick exits carry an environment error, and not when the session ended while the log was written; `tests/tcr-give-up.test.ts` plays each.
Setting `"enabled": false` in `.overwatch.json` takes effect at the next check, with no restart.

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

Each language's rows are alternatives, tried in order: the first whose marker, and tool if it names one, is present runs.
So a JS project runs the vitest or jest it has installed, ahead of `bun test`, Go uses gotestsum's watcher when it is installed, and a Python project without uv runs the `pytest` on `PATH`.
A polyglot project runs a watcher for every language it has, side by side, each with its own part of the status line, for example `overwatch go ✗ 1 failed: TestAdd · overwatch rust ✓ passed`.

A language the project's root lacks is looked for in its sub-projects, the folders up to two levels down, leaving out hidden ones and those `search` in `watchers.json` names (`node_modules`, `target`, `vendor`, `dist`, `build` and the like).
Each folder that has the language gets a watcher of its own, run in that folder and named after it, `overwatch go services/api ✗ 1 failed: TestAdd`, unless a folder above it has it already.
A language at the root covers the whole project, as a Cargo workspace or a JS monorepo with its runner installed at the root does.

A command with no watcher of its own is read by its exit code, so a compile error fails it as surely as a failing test.
Any full run that exits nonzero without printing its summary line counts as failed too, rather than going unreported.
Colour codes are stripped before anything is read, since some tools (deno) print them even into a pipe.

When a build fails, overwatch names the failing tests (or compile errors, where the tool prints them on one line, such as Rust's `error[E0308]: mismatched types`) at the top of the agent's report, and the first of them in the status line: `overwatch python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add`.
A report longer than about 8,000 characters keeps its first quarter and the rest from its end, where cargo, go and pytest print what failed and why.

Python's watch command runs pytest under `--testmon`, which traces every call, so a wall-clock test, one asserting `took 87ms (limit: 50ms)` or reading `elapsed` or `perf_counter`, can fail in watch mode with nothing wrong in the code.
Overwatch still reports such a failure, and adds a line saying that testmon slows it.
To keep timing tests to the full run, mark them, for example with `@pytest.mark.performance`, and give the watch command `-m "not performance"` in `.overwatch.json`:

```json
{
  "watchers": {
    "python": { "argv": ["uv", "run", "--with", "pytest", "--with", "pytest-watcher", "--with", "pytest-testmon", "ptw", ".", "--testmon", "-m", "not performance"] }
  }
}
```

In every project, whatever its marker, zanity runs beside the test watcher whenever `zanity` is on `PATH`, as `zanity check . --watch --no-color --plain` (zanity 0.1.12 or later).
Any error or warning it reports counts as a failure, handed to the agent like a failing build, and the status line shows both results, for example `overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch zanity ✓ checked 12 files, no issues found.`.
Codex, OpenCode, and Pi run the same command after a change, at the same time as each language's suite, and stop it after its first report.
Add another checker to `checkers` in `watchers.json`, its `marker` naming the executable to look for on `PATH`.

In a project whose branch tracks an upstream, the git checker runs beside them whenever `git` is on `PATH`.
Every 60 seconds it fetches and lists the upstream commits the branch lacks, so on trunk the agent hears as soon as `main` moves, for example `overwatch git ✗ origin/main has 2 new commits; pull and rebase: 1084b40 Add the jest runner +1 more`.
Each new commit is a failure of its own, so commits already upstream when the session starts are inherited and only those that land during it ask for a correction; pulling or rebasing moves HEAD, which takes a fresh baseline.
A branch with no upstream, or a detached HEAD, passes with `no upstream to track`.
Codex, OpenCode, and Pi fetch once after each change, like zanity.
Set `OVERWATCH_GIT_INTERVAL` in its `env` to poll at another interval in seconds.

Add a language by adding an entry to `watchers` in `watchers.json`, the one table every integration reads, then run `python3 scripts/table.py`, which copies it into `hooks/table.ts` for Claude Code (whose plugins cannot import JSON); the tests fail while the two differ.
An entry names its marker file, its command, optionally a command that runs the whole suite once first, the line that closes one build's report, and the pattern on that line that means it failed.
Optionally: `language`, to make it an alternative to the entries before it with the same one; `requires`, an executable that must be on `PATH`; `result`, the line to show when the build's result comes before the line that closes its report; and `failure`, a pattern matching each failing test, named by every group that matched, joined by a space.
An entry with no watch command may leave out the summary and be read by its exit code.
Patterns are JavaScript regexes, written as JSON strings.
Codex, OpenCode, and Pi keep each watch command running in one daemon per project, after its full suite when it has one, which starts again any that exits, and reads their reports once every watcher has been inactive for a second, with no output and no change in its processes or their CPU time, so each report covers the files as they were when the hook asked; one still working when its `timeout` passes reports `timeout`, as a check run directly does.

## Per-project override

`.overwatch.json` at the project root, every field optional.
Claude Code, Codex, OpenCode, Pi, and Neovim all read it; `summary` and `failed` are JavaScript-style regexes, which the Neovim plugin translates.

```json
{
  "enabled": true,
  "argv": ["zig", "build", "test", "--watch"],
  "baseline": ["zig", "build", "test"],
  "summary": "^Build Summary:.*$",
  "failed": "failed"
}
```

`"enabled": false` turns overwatch off for that project, zanity included; `"baseline": []` skips the full run first.
The other fields apply to one test watcher alone: in a polyglot project or a monorepo, the first language in the table above that the project has, at its root or in a sub-project.
The override is read only at the project's root.

`watchers` configures any entry of `watchers.json` by its name, test watchers and checkers alike, in a polyglot project or a monorepo too, where a sub-project's watcher takes its entry's settings.
Each takes `enabled`, `argv`, `baseline`, `summary`, `failed`, `env`, variables set for its commands over overwatch's own and merged over the entry's, `timeout`, the seconds a check may run before it reports `timeout`, 540 unless set, and `settle`, the seconds a watch command must stay inactive before Codex, OpenCode, and Pi take its latest report as covering the files, 1 unless set, for a tool that waits longer than that before it rebuilds; the top level takes `timeout` and `settle` too, for the project's own watcher.
A check that times out has a new failure, never inherited, and holds completion and protected actions like any other.
Codex, OpenCode, and Pi honour `timeout` today; Claude Code and Neovim accept it and do not yet time a check out.
An entry turned off gives way to the next of its language, so turning off `vitest` runs `jest` or `bun` when the project has one.
The top-level fields above apply after these.
Codex, OpenCode, and Pi refuse a setting of the wrong type, or a field it does not take, and name it.
`timeout`, `settle` and `tcr.hostLimitSeconds` take a finite number above zero: `0`, a negative number, `NaN`, `Infinity`, `-Infinity`, a string and `true` are refused, and the error names the field.

```json
{
  "watchers": {
    "git": { "env": { "OVERWATCH_GIT_INTERVAL": "300" } },
    "zanity": { "enabled": false },
    "python": { "baseline": ["uv", "run", "pytest", "-m", "not slow"] }
  }
}
```

A project with no marker file is watched when its override names `summary`, `failed`, and `argv` or `baseline`; `name` labels it in the status line.
With no `argv`, overwatch needs no watch tool: it reruns `baseline` itself after the agent's edits (Edit, Write, MultiEdit, NotebookEdit or Bash calls) go quiet.
An edit made while the suite runs stops that run and starts another, so the agent never hears a result its later edits have already overtaken.
Edits made outside the session are picked up at the agent's next edit.
This repository watches its own tests that way:

```json
{
  "name": "plugin",
  "baseline": ["claude", "plugin", "test", "."],
  "summary": "^ \\d+ fail$",
  "failed": "^[1-9]\\d* fail$"
}
```

### Legacy-code triage

A legacy project can start with thousands of errors.
Overwatch records the first result of each check as inherited backlog and sends one short notice with the inventory path.
It saves all named issues and the full original output outside the conversation.
Fixing that backlog is deliberate work; by default, it does not prevent ordinary tools or Stop events.
New failures keep completion guarded, even if other errors were already present.
Updating results never replaces the initial baseline with new failures.
A pull or checkout that moves HEAD under the session brings in failures the agent did not make, so each check reruns and its next result becomes the baseline; in Claude Code, unless the agent edits first.
A move made only by commits, which bring in no files, keeps the baseline, so an edit committed in the same step as the check breaks is still a new failure.
Overwatch reads the HEAD reflog to tell the two apart; when it cannot, the move takes a fresh baseline.
So does a step whose shell command runs a git operation that can bring in files (`merge`, `pull`, `cherry-pick`, `rebase`, `checkout`, `submodule` and the like) or `gh pr checkout`, `gh pr merge` or `gh repo sync`, even when it ends in a commit, as `git merge --squash` does.
Overwatch reads the command as a shell does: operators, parentheses, `$(…)`, backticks and `sh -c` scripts are followed, and quoted text, such as a commit message that names a merge, is not a command.
A command that hides such an operation in a script file, a git alias, or a command substitution inside double quotes is read as a commit.
Also in Claude Code, the first full run can still be going when the agent starts editing; edits made during it are rechecked once it ends, and that first result is no baseline, since it may hold those edits, so every failure it reports counts as new.

Inspect a small batch from the inventory path in the notice:

```sh
python3 engine/triage.py /path/from/notice.baseline.json --limit 20
python3 engine/triage.py /path/from/notice.baseline.json --check go --match TestAdd --limit 10
python3 engine/triage.py /path/from/notice.baseline.json --offset 20 --limit 20 --json
```

Run the script from your Overwatch checkout or use its installed absolute path.
`--check` matches the check, command, or subproject; `--match` searches issue names, both without case sensitivity.
The view groups by check and pages the initial snapshot, with links to full logs.
It does not rerun checks or silently accept new regressions.
When a runner does not name individual issues, the inventory contains its summary and full log instead.
An increase in its reported error, warning, or failure counts is treated as a regression; a replacement issue with the same count cannot be distinguished without issue names.

### Failure gates and protected actions

Failure notifications and permission decisions are separate.
Listing, searching, reading, editing, and running checks are ordinary operations: a red check does not deny them or launch a check before they run.
Post-tool notifications never deny a tool.
Completion stays guarded until the relevant failures clear; deduplicating a notification does not clear that gate.
Warnings retain each check's existing failure policy, including Zanity warnings.

There are no protected tool actions by default.
Configure specific actions in the repository's `.overwatch.json`:

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

Tool names match without case sensitivity; use the tool name your agent sends, such as `Bash`, `bash`, or `exec_command`.
An optional `command` regular expression matches its `command` or `cmd` argument.
Use syntax supported by both Python and JavaScript.
Protect the specific publication or deployment command rather than the whole shell tool, so repairs remain possible.
Without `command`, the rule protects the entire named tool.
`checks` selects watcher names or languages; an omitted or empty list selects all checks.
An unrelated failed check does not block an action scoped to passing checks.
Every protected attempt checks the failure state independently, so a prior denial does not grant the next attempt.

`inherited` defaults to `"allow"`, preserving backlog triage.
Set it to `"block"` to require inherited findings to clear before completion or protected actions.
Ordinary operations remain available under either policy.
A successful check clears its gate; it does not clear failures from other checks.
Environment errors retain their existing reporting behavior.
A `gate` that is malformed, such as an unknown `inherited`, a `protected_actions` that is no list, an action with no `tool`, or a `command` that is no regular expression, is told to the agent, naming the field.
The wording follows the Python engine's for the field names and for the fixed words; the text of a regular-expression error, the repr of a number or of a nested value in a message, and other details differ, and the list of differences is not complete (unverified).
Settings that exist and cannot be read, such as a file the agent may not read, a directory or a pipe nothing writes to, are told once in the same way.
Nothing is held until it is fixed: the tool and the end of the turn go on, as they do in the Python engine.
TCR neither commits nor reverts the edit, as the Python engine does not.
Here TCR also stops, and the agent is told once that it is unavailable because the gate cannot be used, and what to do: fix the file, or the gate setting the gate message names if it names one, and commit any files that changed.
TCR looks at the gate at each turn start.
While the gate is malformed it says nothing more and never says that TCR is on; it starts again at a turn start once the gate is fixed and the files are committed.
The Python engine tells the gate's message at each event and does not stop.
The `command` pattern of a protected action is compiled by JavaScript after three rewrites, which `tests/tcr-gate-patterns.test.ts` pins: Python's `(?P<name>` and `(?P=name)` are written as JavaScript's own; each `$` outside a character class means the end of the text or the end before a last line break, so that `^git push$` protects "git push" followed by a line break; and `\A` and `\Z` outside a character class mean the start and the end of the text.
The same file also pins that `\d`, `\w` and `\b` read ASCII only here, where Python reads every Unicode digit, letter and word boundary.
The two engines of regular expressions differ in other ways that no test pins, and the list is not complete (unverified): what each accepts, what each rejects, how `\s` reads some characters, and the words of the error.
An argument list in a tool's `command` is joined as Python's `shlex.join` joins it, before the pattern is tested.

Command hooks use `PreToolUse` only for protected-action permission decisions and `Stop` for completion.
Ordinary pre-tool hooks return an empty response without rerunning checks.
Claude Code's in-process plugin denies protected tools before execution and replaces guarded completion with a correction request.
It requests another correction for the same findings only after a tool call completes.
Repeated completion attempts remain guarded without queuing duplicate corrections.
Aborted or unsuccessful turns may settle.
After interruption, automatic wakeups wait until another turn starts.
Protected tools remain guarded.
OpenCode and Pi use their before-tool hooks for protected actions.
Reload the plugin after updating hook definitions; Codex may require renewed hook trust.

### TCR mode

Set `"mode": "tcr"` in `.overwatch.json` to run test && commit || revert.
After each edit of the agent that changes files, Overwatch reads the check results and does one of four things.
A checker that is installed on your `PATH`, such as `zanity`, counts as a check, like a test runner the project configures.

- **Commit.** If no check has a new failure against the session baseline, it commits every file that `.gitignore` does not ignore, on the current branch, as `tcr: <files>`. Inherited failures never count, and neither does the `git` upstream check, whose failure is another person's push.
- **Revert.** If a check has a new failure, it restores the files to the latest commit, removes the files the agent added, and tells the agent which failure caused the revert and which files came back. Before it deletes anything it saves the work it discards in a git ref, `refs/overwatch/reverted/<UTC time>`, without moving HEAD or changing the index. The agent is told the ref and the command that gets the work back: `git checkout <ref> -- .`. A version that only the index held, because a file was staged and then changed again, is the second parent of the saved commit, and the agent is told `git checkout <ref>^2 -- .` for it. Set `tcr.saveReverted` to `false` to keep nothing; the revert message then says the work is gone.
- **Hold.** A failing check that has no earlier result in the session, because the edit made it appear, cannot tell a new failure from an old one. The edit stays uncommitted and unreverted, the agent is told which check held it, and the edit is committed together with the next edit once the check passes. A check that had a passing or inherited result before still reverts. A check that outlives its deadline is held too, since a timeout says nothing of what the edit broke. A held check holds the edit again, however much worse it fails, until an edit is committed while it passes: its pass counts as an earlier result only then, so a pass beside another held check, beside a failure that is reverted, or while inherited failures block everything, does not release it. If any check is held, or the host's time limit left an edit alone, or inherited failures that block left it alone, when the next turn starts and nobody changed the files since, TCR stays on and the edit stays; Overwatch tells that by the size and time of every file and by the contents and permission bits of the files that differ from the latest commit. If someone changed them, TCR is unavailable until the tree is clean.
- **Leave alone.** A check that cannot run in the environment, a result that another edit overtook, or a failing inherited check while `gate.inherited` is `"block"` makes Overwatch neither commit nor revert. Results that `engine.py follow` reads between hooks, for a session that watches while idle, are told but never judged: only the result a hook reads after the agent's own edit commits or reverts.

```json
{
  "mode": "tcr",
  "tcr": {
    "saveReverted": true,
    "allow": ["fixtures/.env.test", "**/*.pem.example"],
    "hostLimitSeconds": 550
  }
}
```

`tcr.saveReverted` defaults to `true`.
`tcr.allow` lists paths and globs that a checkpoint may commit although their name or content looks like a secret.
`tcr.hostLimitSeconds` is how long your host lets one hook run; it defaults to 550 seconds: how long the Pi and OpenCode plugins wait for the engine, below the hook timeout of 600 seconds that Codex sets.
An unknown field under `tcr`, or an `allow` entry that is empty or only wildcards, is an error that names the field.
An `allow` entry is cut of the characters that Python's `str.strip()` cuts (U+001C to U+001F and U+0085 among them, U+FEFF not), as the engine cuts it; `tests/tcr-holding.test.ts` pins this for the 29 characters Python cuts.
The error text of these settings writes a value as Python prints it for text, `true` as `True`, the integers `0` and `7`, lists of text and of numbers and a top-level `inf` or `-inf`, which `tests/tcr-holding.test.ts` pins; it writes `1.0` as `1`, `1e16` as `10000000000000000` and a number too large for a float inside a list as `null`, where Python prints `1.0`, `1e+16` and `inf`, which was compared with Python 3 and Node here for those values only; other values may print differently (unverified).

**The saved refs.** Overwatch never prunes `refs/overwatch/reverted/`.
List them with `git for-each-ref refs/overwatch/reverted` and delete them with `git for-each-ref --format='%(refname)' refs/overwatch/reverted | xargs -n1 git update-ref -d`.
A ref holds every file the revert discarded, including a person's untracked files, so a `.env` that was in the tree is in the ref, and `git push --mirror` would publish it.
If a git command takes more than 30 seconds before the reset, as it can in a very large repository, the revert stops before it deletes anything and TCR is unavailable.
A git command that takes this long in the reset or after it is told as described under "A failure or a bug during a revert".
Overwatch saves again while it finds new files, and gives up without deleting when the files keep changing.
It then removes only the untracked files of its last look, so a new file written after that look stays and the agent is told it was left.
A file of that look, or a tracked file, that changes in the tens of milliseconds between the last look and the reset is lost, because git cannot reset and look in one step.
A revert does not go into submodules: the files inside one stay as they are, and the message to the agent names each submodule that still holds changes.

**What TCR sees of a held edit's files.** It recognises a held edit again by the size and modification time of every file, and by a digest of the content of the files that differ from HEAD.
The digest reads at most the first 50 MiB of a file, so a change after those bytes that leaves the size and the permission bits as they were is not seen.
A pipe or a device is opened without blocking and is not read, since a read may never end: its digest holds its size and permission bits only.
A socket cannot be opened, so it is digested as missing.
A change of what a pipe or a device holds is therefore not seen by the digest; its modification time still is, by the fingerprint.

**A failure or a bug during a revert.** Overwatch lists the changed files and reads HEAD before it resets the tree.
After the reset it runs only the removal of the untracked files, the check of the tree and a second listing of the changed files.
A git command that fails after the revert began, or an error raised in one of those steps, is told to the agent with the saved ref, and TCR is unavailable.
This holds for every error that the entry point treats as unexpected, `ValueError`, `TypeError`, `KeyError`, `SubprocessError` and the engine's bugs, and for `OSError`; the exit code stays 0, and the traceback of all but an `OSError` goes to stderr.
The notice says `TCR reverted` only when git reported that the reset succeeded.
When the reset failed, or timed out so that nobody knows whether it ended, the notice says that TCR tried to revert and that git failed, or that a bug stopped it; a bug is named as one.
The notice names files only as the two listings show them: `Restored` for a file that the first listing has and the second does not, `Still changed` for a file in both, and `Changed after TCR listed the files` for a file only the second has.
It gives no cause for a file that is still changed and does not say that files are unchanged: `git status` shows the present state.
The notice of an attempt, when the reset did not succeed or nobody knows whether it ended, lists a file of the first listing that the second does not list as `Now as HEAD has them`, not as restored.
The sentence says how the file is now, and not who made it so.
When git cannot list the files after the reset, the notice says so and names no file as restored.
A read that fails before the reset, such as the log of the failing check or the submodule list, reverts nothing: TCR is unavailable, the failing edit stays in the tree, and the next turn start says the tree is dirty.
A HEAD that git cannot name does not stop the revert.
A bug in building the text of the message or the answer tells the agent that TCR tried to revert, with the saved ref when the answer gave one.
The notice of a revert is queued before the logs of the failing checks are written, so it never waits for a disk.
Each revert has its own notice: a second revert before the first notice is sent does not replace it.
Five notices of reverts wait at most; the reverts and attempts after them are told as one count that names no files and says how many saved a copy.
A notice that the host did not take, which a newer notice of a revert took the key of, waits in a free place or is added to the count: no revert notice is lost.
A log that is not written within the limit of a read is left out of the notice, which then names no log for that check; a notice that went out before the log was written does not name it either.
When the host's time limit stops a judgement after the revert command was asked, the pause says that a revert was asked, with the saved ref when it is known.
An error of the plugin itself is told to the agent once and written to the transcript, where the user sees it; a failure of the host is written to the debug log only.
A notice that the host does not take stays waiting.
It is sent once more on its own, and goes out with the next one after that.
A notice the host refuses after its session ended is dropped: it is never told in the next session.
A host that stores a notice and then fails is given it again, so the agent may read it twice.
A notice lost is worse than one read twice, since a revert the agent never hears of leaves it working on files it thinks it has.
The engine's entry point catches `OSError`, `ValueError`, `TypeError`, `KeyError` and `SubprocessError`, as it does for every event: it prints a system message and exits 0, which a host may not show.
A bug that is none of those, such as an `AssertionError` or a `RuntimeError`, raised before the reset ends the hook with exit code 1, its traceback and nothing on stdout.
After the reset, every error of the kinds above and every such bug is told as the revert with the saved ref, with exit code 0 and the traceback on stderr.
`KeyboardInterrupt`, `MemoryError` and `SystemExit` are not converted, before or after the reset: the hook ends with no JSON, and after the reset the agent is not told the saved ref.
A `KeyboardInterrupt` ends the hook by the interrupt signal, with exit code -2 to a parent that reads the signal and 130 to a shell, and its traceback on stderr; a `MemoryError` exits 1 with its traceback; a `SystemExit(n)` exits n and prints nothing, so a `SystemExit(0)` exits 0 with no output, which a host reads as success; and a SIGTERM ends it with -15 and nothing on stderr.
In none of these cases does anything, stderr included, tell where the saved ref is; list the refs with the command above.
No assert of `tcr` or `tcr_texts` inspects the text of a notice, so a file named like one of its sentences cannot stop the hook.

**What a notice prints of text it does not control.** A file name, a submodule name or a ref is written with an escape for control characters, line and paragraph separators, spaces other than the plain space, format characters such as bidirectional marks and zero-width ones, and backticks, and is cut at 200 characters with `...`; a notice lists at most five of them and then how many more.
A summary or git's own message is written with the same escape, except that it keeps the tab and its backticks, and it is not cut.
The plugin names the categories of the characters it escapes with the Unicode tables of Node, and the engine with those of Python; a character that one has assigned to one of these categories and the other has not yet would be raw in one notice and an escape in the other.
`tests/test_hook_unicode_tables.py` first compares the categories that `hooks/safe-text.ts` names with those of `engine/safe_text.py`, and fails when a rule differs, as it does when `\p{Cf}` is dropped from the plugin.
It then compares the two tables on the machine it runs on, for the code points that both versions of Unicode assign, and fails on any difference; it prints how many code points it leaves out because only one version assigns them.
Run on this machine: Python 3.15.2 (Unicode 17.0) with Node 26.13.0 (Unicode 17.0), and Python 3.13.18 (Unicode 15.1) with Node 26.13.0, show no difference.
Not run: Python 3.11, the oldest the engine needs, with any Node.
A review reported that Python 3.11 (Unicode 14) and Node 26 differ on U+13439 to U+1343F, which Node writes as an escape and Python 3.11 keeps raw (unverified here).
The CI job `unit` runs the test with the `python3` of its runner and Node 22, and which versions those are is unverified; the job with Python 3.11 runs only `tests/test_engine_entry.py`, so no job compares Python 3.11 with Node.
A fixed table of ranges in the plugin and the engine would make both agree whatever the version, but a character that a later Unicode adds would stay raw until someone edited the table; this is not done.
A command, a check name, a failing test name, a directory and a path are written with an escape for line breaks and control characters other than the tab, and nothing else is changed, so a command can still be copied.
A path is never cut.
The same holds for the data directory in the notice of an inherited backlog and for the error text the hook prints.
A command, name or directory with no line break or control character prints as it did before these escapes, and so does a summary with no hiding character.
A summary that holds a raw ESC, NBSP, ZWSP, bidirectional control or line break is written with escapes.

**A checkpoint never commits secrets or very large files.** It refuses a file named `.env` or `.env.*` (except `.env.example`, `.env.sample` and `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `id_ecdsa` or `id_dsa` (also with a suffix, as in `id_rsa.bak`, but not `.pub`), `*.keystore`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `kubeconfig`, `terraform.tfstate`, `secrets.yml`, `secrets.yaml`, or `credentials`, `credentials.json`, `credentials.yml` or `credentials.yaml`.
It reads a file that replaces a symlink, or the other way round, like any other file.
It also refuses a line that the edit adds, in a text, UTF-16 or binary file, and that holds an AWS access key id, a private key header (also an encrypted one), a GitHub token that starts with `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_`, a Slack token that starts with `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-` or `xoxs-`, a Stripe live key that starts with `sk_live_` or `rk_live_`, an Anthropic key or a Google API key.
A GitHub token or a Stripe live key with a letter or digit before its prefix is not seen, as in `Xghp_`, `7sk_live_` or `Xgithub_pat_`.
A file over 50 MiB, new or changed, is refused too, from its size on disk and before git reads it.
When the diff of the staged files is not in a form the guard reads, it refuses each file it could not screen, with the rule `its added lines could not be read, so they were not screened for secrets`; an entry of `tcr.allow` skips that screening for the file it names.
When it refuses, Overwatch commits nothing, reverts nothing, leaves the files in the working tree unstaged, and tells the agent each file and the rule, as `.env (name pattern)` or `src/a.py:12 (AWS access key)`, and that TCR stays unavailable until you commit the pending edit yourself.

`tcr.allow` entries are paths from the repository's root.
A star matches within one directory or file name and never crosses a `/`, a name without a directory matches only that name at the root, and `**/` before a name matches it in any directory: `".env"` allows `.env` but not `deploy/prod/.env`, which `"**/.env"` also allows.
An entry skips the name and content rules for the files it names and never the size limit.
Add what is safe to commit to `tcr.allow`, or what is not to `.gitignore`, then commit the pending edit: TCR starts again at the start of the next turn once the tree is clean.

The guard is not a secret scanner.
It does not see a secret that is split across lines, a bare secret, a JWT or a base64-encoded one, a secret in a file whose encoding does not write ASCII as itself, such as EBCDIC, a password in a URL such as `postgres://user:pass@host`, an OpenAI `sk-proj-` key, or a password in a plain assignment, and it flags any text that holds one of its keys, such as a README that quotes `sk_live_`.
There is no generic `key = "..."` rule, because that rule flagged ordinary code.
Screening 1000 staged files is one `git diff`, and a test fails if it takes more than two seconds.

TCR starts only on a clean tree, on a branch that has a commit, with no merge, rebase, cherry-pick, revert or bisect in progress, no untracked nested repository, no tracked file that is marked `assume-unchanged` or `skip-worktree` and differs from the latest commit in content, in mode or in being a file or a link, and at least one check configured.
A checkpoint and a revert refuse for the same reason, so that neither commits nor overwrites an edit that git does not show.
Otherwise Overwatch tells the agent that TCR is unavailable, and why, and changes nothing.
When the tree is dirty it names the files, and when a check wrote them, such as `report.xml`, it says that the checks changed the files while they ran and to add what a check writes to `.gitignore`.
When the branch is `main` or `master` it tells the agent once that checkpoints land on it.
Overwatch checks again at the start of each turn in Codex, OpenCode 1 and OpenCode 2; Pi reports only the start of a session, so there TCR does not start again after it became unavailable.
In a project whose `.overwatch.json` sets `"mode": "tcr"`, OpenCode 1 holds a message until the check that its session start began has ended, which can be as long as the baseline run, up to the 550 seconds that the plugin waits for the engine.
The agent's first edit waits for that check only if OpenCode waits for the `chat.message` hook before its first model call; no real OpenCode host has shown that.
A project that does not set the mode has no wait and no check for a message.
In OpenCode 1, a `.overwatch.json` that is not a regular file, is larger than 1024 KiB, or takes more than 1 second to read counts as no mode for that message.
A file that the user cannot read, and a file that is not valid JSON, count as no mode too.
A UTF-8 byte order mark at the start makes a file invalid JSON, as it does for the engine.
OpenCode 1 checks each message only in a session whose start announced TCR, as on or as unavailable; a session that started without TCR needs a new session after TCR is turned on.

To turn TCR off, remove `mode` from `.overwatch.json`: the next event tells the agent that TCR is off, and nothing is committed or reverted.
OpenCode 1 shows the "TCR is off" notice to you at your next message in a session that announced TCR, and not to the agent.
Setting `"enabled": false` stops every check, so TCR commits and reverts nothing.
The next turn start then says that TCR is unavailable because every check is off.

TCR assumes the agent is the only writer.
A revert discards every change that is not committed, so with `tcr.saveReverted` set to `false` a person's work in the working tree, or a second agent's in the same checkout, is gone.
When Overwatch sees files change at an event that no editing tool announced, it makes TCR unavailable until the next turn start, so a revert cannot discard those files.
A shell command counts as an editing tool, so what it writes is judged as the agent's edit: committed when the checks are green, and saved to a ref and reverted when they are not.
Before an editing tool runs, and when no editing tool runs, it fingerprints the files, which takes longer the more files the project has, and a difference from what the agent's last edit left makes TCR unavailable until the next turn start.
An editing tool that begins while that comparison runs waits for it, so a batch of parallel edits costs one comparison.
The comparison has a limit of 20 seconds that also covers the search for the repository and the read of the settings, and past it TCR is unavailable and the tools run.
Every other read of the project's files, such as `.overwatch.json` after a tool ran, the git directory, the reflog and the search for the checks, has the same limit; past it TCR stops and the agent is told that a read took longer than the limit, also when TCR was not decided yet, since the read cannot tell whether it runs; the notice then says that overwatch cannot tell whether the project uses TCR.
A revert that ends after its session ended queues no notice for the next session, whose agent knows nothing of the edit; the user gets a toast instead, whenever the revert may have discarded files.
It names the ref that holds the work when the answer gives one, says that no copy was saved when the command said so or the project turned saving off, and says that no copy is known when the command crashed, printed a traceback or gave no ref.
A revert that changed nothing tells nothing.
`tests/tcr-ended-session.test.ts` checks the toast with a ref in each wait of a revert, and `tests/tcr-ended-notices.test.ts` checks the others.
An error while a session ends is told and written to the log of the host, and the end of the session goes on; once a newer session began, it is only a toast (below).
A read that began in a session that has ended stops nothing in the next one: a checkpoint, a revert or a read that answers late is dropped, and `tests/tcr-ended-session.test.ts` ends the session in each wait of a checkpoint and of a revert.
A message or a pause that follows an await in the same function is made only while the session that began the work is the current one: the hold of an edit, the read of the settings, the note of the branch, the regression of a log that is written late, the stop for a gate that cannot be used and the judgement after the gate is read each check it.
An unexpected error that surfaces after a newer session began is shown to the user as a toast, and it tells that session nothing and pauses nothing; the same error, reaching the entry of the newer session itself, is told to that session once and pauses its TCR.
`tests/tcr-boundaries.test.ts` pins the text of the toast and both orders of the two entries.
A search for checks that began in a session that ended and fails with a bug of the plugin is shown as a toast in the same way; the search the newer session asked for still runs, so its edits are judged by its checks, and the agent is not told that no checks are configured; `tests/tcr-search-across-resume.test.ts` plays the failure 50, 200, 600 and 1200 ms after the first edit of the newer session, and a read that outlasts its limit, which shows nothing.
`tests/tcr-stale-answers.test.ts` holds the policy read of the gate, the files listed after the checks changed them, the files listed for a pause over a change outside and a read of the settings that outlasts its limit past the end of a session, and ends the session in each; `tests/tcr-boundaries.test.ts` does it for the files compared for a gate that cannot be used.
Each shows that the next session is left as it was.
`tests/tcr-ended-notices.test.ts` holds the question that a hold asks, and the failing search of an old session, across the end and the start of a session; `tests/late-reads.test.ts` and `tests/late-paths.test.ts` do the same for the other calls.
A read that never answers is never taken for a missing check or for a HEAD that did not move.
A look for the git repository that outlasts its limit is remembered for 10 seconds, for that directory only: the looks for it in that time fail at once with the same error and say they were not tried, so a read that does not answer delays one call and not each.
The search for watchers uses the same memory.
A look that works clears it.
Two looks for the same directory that begin together each wait their own limit and are not joined: a limit, pinned by `tests/tcr-lifecycle-gaps.test.ts`.
The end of a session waits for a search in flight no longer than one read limit.
The agent is told once that the gate cannot be read for that reason, as for a malformed gate, and the tools and the end of the turn run.
No editing tool of the batch writes while the files are read; the editing tools are `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Bash`.
A tool of another kind, such as an MCP tool, is not held and can write while the files are read; what it writes differs from what the agent's last edit left, so TCR stops as for a change outside the agent's edits; `tests/tcr-held-tools.test.ts` pins that it is not held.
A person's file written since the agent's last edit is found when the batch holds one tool and when it holds many.
An editing tool that begins while another one runs compares nothing, since the running tool's write may be what changed the files.
A person's file written after the comparison read the files, and any file written while an editing tool runs, goes with the agent's edit, since the two writes cannot be told apart.
An editing tool that the host never ends counts as running until the turn completes or the session ends, so the editing tools that begin later in that turn compare nothing, and a person's file written meanwhile goes with the agent's edit.
It cannot tell a person's write from the agent's while an editing tool runs, so a file a person writes during a shell command or an edit, or while two editing tools run at once, is committed or reverted with the agent's edit: do not edit the working tree, or run a second agent in it, while TCR runs.

The baseline is the first result of each check in the session.
It stays while HEAD moves by commits alone; a move that brings in files, such as a checkout or a pull, takes a new baseline.
A check that failed at the start, and that an edit made pass, is committed; when a later edit makes it fail again, that failure is not new against the baseline, so TCR commits it.
Fixing an inherited failure and breaking it again is not reverted.

The repository's commit hooks and signing run.
If a checkpoint commit fails, the changes stay staged, nothing is reverted, and TCR is unavailable until it can start again.
A check that fails while no file differs from the latest commit leaves the edit alone, and the agent is told that there is nothing to revert.
When a check writes files that git does not ignore while it runs, Overwatch judges nothing for that edit and tells the agent which check wrote which files and to add them to `.gitignore`.
With `gate.inherited` set to `"block"`, an edit that leaves an inherited check failing is neither committed nor reverted.
TCR stays on at the next turn start when nobody changed the files since, and the edit stays in the working tree.
A later edit that leaves no inherited check failing commits it.

A host stops a hook that runs too long.
TCR commits only when the checks left at least 30 seconds of `tcr.hostLimitSeconds`, and reverts only when they left 150, which is three saves, the reset and the clean at the 30 seconds each git command may take.
A checkpoint runs about 30 git commands and a revert about 50, each limited to 30 seconds, so these reserves assume a normal repository and are not a sum of the limits; more files, or files that keep changing, add commands, and in a very large repository a phase can outlast its reserve, and the host may then stop the hook.
Otherwise it holds the edit and says how long the checks took.
If `git` needs more than 5 seconds to list the files, Overwatch says so and does nothing, TCR included, until it is faster.

The engine needs Python 3.11 or newer.
On Python 3.9 the hook of Codex, OpenCode and Pi prints `overwatch needs python 3.11 or newer` as JSON and exits 1, and nothing is committed or reverted.
Python 3.10 was not tried.

TCR works in Codex, OpenCode and Pi.
The engine commits and reverts, and the host's hook hands the engine's notice to the agent.
The tests run the Codex hook with real git; they run the OpenCode and Pi plugins with a fake engine, so no real OpenCode or Pi host has run TCR.
OpenCode 1 shows the "TCR is on" notice to you but not to the agent.
Claude Code has its own rules, in the subsection "In Claude Code" below.
A revert removes empty directories, and a rename that only changes letter case is invisible to it on a case-insensitive filesystem.

#### Using TCR well

The points below were checked against five texts: two posts of Kent Beck ("test && commit || revert", and the second part of "Limbo on the Cheap"), the post of Lars Barlindhaug, the post of tom-010, and the auto-captions of Kent Beck's video "Understanding Legacy Code with TCR".
The text of each is on disk.
The user pasted the texts of Beck's "test && commit || revert", of Barlindhaug and of tom-010 because the page answered HTTP 403 to the fetch tool.
The user pasted the Limbo text as its second fragment, without the opening paragraphs; its header does not say why.
The text of the video is its auto-captions, not a pasted text: the file is `FFzHOyFeovE.en-orig.vtt`, which the video's metadata lists under `automatic_captions`, so the words of a video quote are as the captions have them, with no punctuation of the speaker's.
A direct quote comes only from these five.
A point tagged `reported by <name>; the text was not checked` rests on a source that was not opened.
A point that no source says is marked as inferred.

- Make the check build first when a compile error must cause no revert. Beck's "test" script “builds the system, runs the tests, and only returns 0 if all the tests pass” [Beck, Limbo on the Cheap]. That a failed build is red in his script is inferred, since the text names only the tests. tom-010 says that with the original command “As soon as your project does not compile it reverts”, and that his variant “tries to build the software first. If it fails, nothing is executed — no commit, no revert” [tom-010]. Barlindhaug writes: “If ./test exits with an exit code 0 or 1 depending on success or failure, it should work out of the box on any unix terminal” [Barlindhaug].
- Keep a tool's output out of what the commit takes and the revert removes. Barlindhaug's commit is `git commit -am working`, which takes “all changed files”, and his revert is `git reset --hard`, which “reverts all the changes you have done to all the files” [Barlindhaug]. A file that a tool writes into the tree is therefore committed or reverted with the edit (inferred). Of the variants, Relaxed, Split and The buddy revert one directory, `git checkout HEAD -- src/main/`, and the watch buddy reuses The buddy's script; its code, `inotifywait -r -e modify .`, watches the whole tree, whereas the text after it says “ionotifywait -r src blocks until there is a change in the src directory”, so its text and its code disagree [tom-010]. That the output of a watcher that git does not track belongs in `.gitignore` or outside the repository follows from this (inferred); `.gitignore` does not ignore a file that git tracks, and the rule for it is in "In Claude Code" below. Barlindhaug's team found one file hard to change while a sync script changed it: “When one person was in the flow changing one file, it was near impossible to get work in because it was constantly changed by our sync script” [Barlindhaug]. That a tool that writes a file the agent edits has the same effect is inferred.
- Use checks that finish fast and do not flake (inferred): each red is followed by a revert, so a slow or flaky check costs work. The same is said by Tanzer, and by ewjordan and l0b0 on Hacker News (reported by Tanzer, ewjordan and l0b0; the text was not checked).
- Split a big change into steps that each keep the checks green. Beck: “If you don’t want a bunch of code wiped out then don’t write a bunch of code between greens”, and “you can’t solve big problems in one small step” [Beck, test && commit || revert]. “The challenge of finding a way to make a (relatively) large change in small, safe steps was interesting and seldom frustrating” [Beck, Limbo on the Cheap]. “Only focusing on the next little thing actually made us faster than trying to fix a big thing in one go” [Barlindhaug]. Big refactors across many files are said to fit TCR badly (reported by wink on Hacker News; the text was not checked).
- Try TCR because it is cheap, not because it is better than what you do now. Beck: “I don’t suggest you try “test && commit || revert” because it’s better than what you do now. I suggest you try it because: It’s cheap. You’re bound to learn something.” He wrote: “I’m not arguing for” it [Beck, test && commit || revert]. In his video it finds out what existing code does: “you use TCR to write tests for existing code” [Beck, video, auto-captions].
- Do not use plain TCR when you want to watch a test fail first. tom-010 says that with the original command “as soon as the current test fails, the test gets deleted”, and that his Relaxed variant resets only `src/main/` so that the tests stay [tom-010]. In Beck's video the assumptions about the code are recorded as tests, and “if we're wrong is gonna be gone” [Beck, video, auto-captions]. That the wrong test goes with the code, as it does in the original command, is inferred. That exploratory work and debugging fit TCR badly is inferred; debugging a failed test is said to defeat the purpose (reported by Voulgaris; the text was not checked).
- Squash the `tcr:` commits before you push (inferred). The scripts of Barlindhaug and Beck commit each green state with the message “working”, and both push them: `git pull --rebase; git push` in a loop [Barlindhaug; Beck, Limbo on the Cheap]. Beck calls Limbo a strategy “for scaling collaboration” [Beck, Limbo on the Cheap]. That the history fills with such commits is inferred. That `git bisect` stops being useful is said by LukeShu on Hacker News and by Software Sunshine (reported by LukeShu and Software Sunshine; the text was not checked), and the advice to squash before you share by n_develop and Tanzer (reported by n_develop and Tanzer; the text was not checked).

Sources.
Checked, with the text on disk:

- Kent Beck, "test && commit || revert", Medium, 2018-09-28.
- Kent Beck, "Limbo on the Cheap", Medium (a fragment).
- Lars Barlindhaug, "How to test && commit || revert", Medium, 2018-10-17.
- tom-010, "TCR Variants (test && commit || revert)", Medium.
- Kent Beck and Kelly of Gusto, video "Understanding Legacy Code with TCR (test && commit || revert)", 2019-10-15 (its auto-captions).

Not opened; their links were not opened and are not printed:

- Tanzer, Voulgaris and Software Sunshine: posts on TCR.
- n_develop: a post on dev.to.
- A Hacker News thread on TCR, with the comments of ewjordan, l0b0, wink and LukeShu.

#### In Claude Code

`"mode": "tcr"` in `.overwatch.json` makes the Claude Code plugin commit the agent's edits that keep the checks green and revert the edits that add a failure.
A failure is new when the session's own baseline did not have it, so inherited failures never cause a revert.

```json
{ "mode": "tcr", "tcr": { "allow": ["fixtures/token.txt"] } }
```

A short while after an edit changed files, the plugin runs every check once, a check with a baseline command to its end and a watch-mode check until its first report, and judges the edit by those results.
A checker installed on the machine counts as a check, so a project that only has one still runs TCR.
A green edit is committed as a checkpoint named `tcr: <files>`, with the repository's own commit hooks and signing.
An edit that adds a failure restores the latest checkpoint, and the agent is told the failure, the files that came back and the git ref that holds what was removed: `refs/overwatch/reverted/<time>`, which `git checkout <ref> -- .` brings back.
`tcr.saveReverted` set to `false` keeps no such ref.
A revert removes empty directories, and a rename that only changes letter case is invisible to it on a case-insensitive filesystem.

TCR neither commits nor reverts in these cases, and tells the agent why:

- The check fails and has no earlier result to compare with, or a check could not run, gave no summary or ran past nine minutes. The edit stays in the tree, and a check without an earlier result, or one that ran past its limit, stays without one, whatever it fails with, until it passes. At the next turn start TCR resumes when the files are still exactly that edit, by their sizes, times and contents. A check that could not run here is not remembered: the edit stays in the tree, and TCR is unavailable at the next turn start, since the tree is not clean, until the edit is committed or discarded.
- A newer edit or any other change of the files came first. TCR looks at the files again right before it commits or reverts and when it is done, so a result that was overtaken acts on nothing, and files changed by a person before an editing tool begins, or at a tool that does not edit, make TCR wait for the next turn. An editing tool that begins while TCR's own revert runs finds the files changed and the notice blames files changed outside the agent's edits, though TCR stops either way.
- A revert fails once it began to discard the work, as git refuses the reset or a step after it fails, or the command stops without an answer. The command says how the reset ended: done, failed when git ran it and it exited with an error, or unknown when it timed out or could not run. Only a reset reported as done is told as a revert: TCR reads the files again and says it reverted part of the change, lists the files that are no longer dirty, the files of the edit that are still changed and the files that changed after TCR listed them, with the ref that holds what was removed. Otherwise it says it tried, says that git failed only when the command reported a failed reset, lists the files that no longer differ as now as HEAD has them, never says the files are unchanged, and names the failing check, its log and the ref that holds a copy. A revert that worked, after which the files are dirty again, says they changed again. When the files cannot be read again it makes no claim about them, even if the reset ran, and `git status` shows what happened. A list names at most five files and counts the rest. A revert that failed does not say where the staged version is in its ref, or which submodules it left alone, and when the command died or ran past its limit the notice cannot name the ref and says how to list the saved copies. TCR is unavailable until a turn start finds the tree clean.
- The command answers a revert with a field missing, of the wrong type, or at odds with another field. When the answer says the files were reverted, TCR tells the revert as the engine's reset gives it, as one it tried when the reset is missing or is not done, failed or unknown, names the ref the answer gives or says that it is not known, and stops with the answer as the reason. Otherwise TCR stops with the answer and tells no revert.
- The checkpoint would commit a file whose name or content looks like a secret, or one over 50 MiB. The reason names each file as `path` or `path:line` with the rule; add what is safe to `tcr.allow`, or to `.gitignore`, and run `git rm --cached` on a file that git tracks.
- The first edit of a turn can land before the turn start has finished asking whether TCR can run. That takes a few hundred milliseconds (an estimate, unverified). TCR then cannot tell whose the change is, so it stops with the notice "files changed while TCR was committing, reverting or deciding, so it cannot tell whose they are". The edit is neither committed nor reverted. At the next turn start the edit counts as uncommitted changes, and the notice says the working tree has uncommitted changes. Later edits stay uncommitted too. TCR starts again at the first turn start after you commit or discard those changes. An edit that lands while another edit already waits is judged with it.
- The working tree is not clean when the session starts, a commit hook fails, or `.overwatch.json` holds a `mode` other than `"tcr"` or a `tcr` setting of the wrong type. The reason is named, and TCR starts again at a later turn start when it can.
- HEAD was moved by someone other than TCR, as a pull or checkout does. What TCR held is forgotten, since the baselines it held against are gone. An edit made in the step that moved HEAD is neither committed, held nor reverted, since the failures the move brought in are inherited; the files stay as they are until the next edit or turn start.

Files that a project's own watcher or tool writes pause TCR when they appear at a tool that does not edit, as any change from outside does.
Files that git does not track and that `.gitignore` ignores never count: the fingerprint lists the files with `git ls-files -co --exclude-standard`, which still lists a tracked file that `.gitignore` also matches.
A tracked file counts even when `.gitignore` lists it: remove it from the index with `git rm --cached`, or do not track it.
Any other file pauses TCR until the next turn start, and the notice names the files that differ from the last checkpoint and says to add the tool's output to `.gitignore`, and to run `git rm --cached` on a file that git tracks.
The plugin reads the status letters of `git status --porcelain` only to find the second path of a rename or a copy, which has no letters, and it names both paths; it does not use them to tell an untracked file (`??`) from a tracked one, so the notice gives both directions.
`tests/tcr-status-letters.test.ts` pins that the names come without the letters, and that a rename or a copy names both its paths.
That list holds every file git shows as changed, the uncommitted edits of the agent too, since git cannot tell whose they are (limit).
`tests/tcr-decisions.test.ts` pins both cases with a fake engine that leaves ignored files out of its fingerprint, and `tests/test_checkpoint_command.py` pins that the real fingerprint does for an untracked file, and that it does not for a tracked file that `.gitignore` lists.
The rule is a decision, not a finding: a watcher that writes files git does not ignore is told to the agent as a change from outside.
While TCR judges, or waits to judge, an edit of the agent, the checks do not tell the failure of that edit themselves, since TCR tells it by a revert or by why it held the edit.
The guard of a turn's end says nothing of a new failure that TCR tells, has reverted or has not judged yet: a turn that completes while TCR judges ends, and the revert notice reaches the agent once, not after a guard that sends it to fix a failure TCR removed.
The guard of a protected tool is unchanged: it still denies the call while such a failure stands (limit).
`tests/tcr-stop-guard.test.ts` plays a turn that completes 700 and 900 ms after the edit, and pins that the guard of a protected tool still denies the call in TCR while such a failure stands.
The guard still speaks of a failure that the checks tell, when TCR is paused or left it to them, and of an inherited failure when `gate.inherited` is `"block"`.
When TCR stops before it judged the edit, the checks tell the failure they reported meanwhile.
When TCR holds the edit for a check that gave no result, it names no failure, so the checks tell the failures they reported and each later one.
The checks always tell a failure that follows a commit of the agent, and the decision at a turn start keeps that: a failure that comes after the next turn started is told too.
A failure that follows a change of a person, with no edit of the agent waiting, is kept and told once, when TCR stops for that change or at the next turn start.
While TCR is active the guard of a turn's end does not tell it, so it reaches the agent once, one turn start later than the failure of an edit does.
In four states the guard of a turn that completes after the check reported the failure tells it, and the check tells it again at a next turn start, so the agent hears it twice (limit): paused by a change outside, unavailable at the start, holding an edit for a check that gave no result, and left to the checks by the agent's own commit.
An editing tool that changed no file, such as `ls` in Bash, leaves the kept failure as it is; before, it dropped the failure.
A failure that the checks report after TCR committed an edit green is kept the same way: a turn that completes then is not stopped for it, and the next turn start tells it once (limit).
`tests/tcr-kept-failure.test.ts` pins both.
The condition that an editing tool that changed no file gives the marks back only while no other editing tool runs (`state.tcrEditing.size <= 1` in `hooks/register.ts`) is not pinned (limit): with it removed, no test fails, and two overlapping tools that change no file, with a result of a check between their ends, tell a failure of a change outside once with and without it.
A tool that changed no file gives the marks back as they were before it, also when a result of a check arrived while it ran; no test shows an effect of that (unverified).
A failure that a change of a person brought, and that still stands when the agent edits next, counts against that edit: the check compares with the first result of the session, not with the result before the edit, so TCR reverts the edit and the notice names the failure as the cause (limit).
`tests/tcr-kept-failure.test.ts` pins that too.
A `/clear` does nothing in the plugin: the early return of the `session.end` hook for the reason `clear` skips the end of the session, so the watchers keep running and the set of toasts shown stays, and a failure told before `/clear` is not told again to the cleared conversation (limit).
The types of the host say that `/clear` fires `session.end` with the reason `clear` and no `session.start`; the test plays that event shape, and no real `/clear` was run (unverified).
A failure whose edit a newer edit of the agent replaced is not told as the failure after the latest change, since the check did not run again yet.
A failure that the checks report after TCR judged the edit it follows, and that the run of TCR itself did not find, is told by nothing (limit): the two runs of a check can differ.
`tests/tcr-untold.test.ts` pins that for an edit TCR committed and for one it left held with `gate.inherited` set to `"block"`.
A failure that follows a pull is inherited with the pull, so nothing tells it, by design, since its cause is not known.
The seven files `tests/tcr-told-once-0.test.ts` to `tests/tcr-told-once-6.test.ts` play 140 cases through `tests/fixtures/tcr-told-once.ts`, 20 for each state, and fail when the agent is told the failure other than once, except in the four states named above.
Each case is one of seven states of TCR (active, paused by a change outside, unavailable at the start, holding an edit for a check that gave no result, left to the checks by the agent's own commit, active after a checkpoint, decided again after the session resumed), a failure from a change that the agent did not make or from an edit of the agent, a failure that comes before or after the next turn started, and a turn that does not complete or completes 300, 700, 900 or 1500 ms after the failure begins.
A case counts the mentions of the failure in the texts the agent was told, apart from the texts of the guard, which it counts as its own.
In every state but the four, the case asserts one mention and no mention in the guard; in the four, it asserts one mention by the check, at most one by the guard, and a guard mention only when the turn completed.
The last test of a shard asserts for each of the four states how many of its cases tell the failure twice: 12 for a pause by a change outside, 12 for the state unavailable at the start, 7 for the hold, and 6 for the state left to the checks.
When TCR reverted, no guard text may carry the failure.
The run of TCR of the check takes 300 ms in every case, so that the check's own result comes before the revert, and a second telling by the checks of a failure that TCR told fails a case.
Each case asserts what its state shows before the failure begins: a notice that was told, a commit, a move of HEAD, a dirty tree or a new decision.
The last test of a shard also checks that its 20 cases ran and reached their state.
The watcher of a case prints the failure once, as a watcher that prints only a change does, so that a repeated print cannot hide a failure that was dropped.
The cases do not play a failure that follows a pull, which is pinned in `tests/tcr-untold.test.ts`, or a person's change that comes while an edit of the agent waits to be judged.
`tests/tcr-untold.test.ts` pins that the checks tell the failure when TCR stops before it judged the edit or holds it for a check that gave no result, also when a new turn started in between, that a failure TCR told is not told again, that a failure of a person's change and one that a pull brought are told or not as above, and that with `gate.inherited` set to `"block"` a new failure beside an inherited one is reverted and told once.
`tests/tcr-holding.test.ts` pins that the checks tell a failure that follows a commit of the agent.
A failure that the checks report only after TCR stopped is told when they report it.
Messages about a gate that cannot be used go out in a turn that was told already, like those of TCR; the other messages of Overwatch wait for the next turn.
`tests/tcr-pausing.test.ts` pins that for the message about a gate that cannot be used.
A check that cannot be stopped when a newer edit cancels a judgement is told to the user once and to the agent, one message for each distinct reason, and the newer edit is still judged; a stop that fails after its session ended tells nothing to the next session, and a failure of that telling is written to the log of bugs; a check that cannot be stopped may keep running unseen (inferred, not run).
`tests/tcr-pausing.test.ts` pins that with a stop that fails as an expected failure and with one that is a bug of the plugin, which is also written to the log of bugs.

Every name, command, directory, path, summary and error text that a notice or a status line carries is written by the rules of "What a notice prints of text it does not control": a file name or a saved ref with an escape for a control, format, line-separator, paragraph-separator or space character other than the plain space, such as a line break, a bidirectional override, a zero-width character, a byte order mark or a no-break space, and for a backtick, cut after 200 characters; a summary and git's own words in the same way, but keeping the tab and the backticks and without a cut; a command, a failing test name, a directory and a path with an escape for line breaks and control characters other than the tab, and nothing else changed.
The notice of an edit held for a check writes the check's name by that last rule.
The notice of files that a check wrote writes the check's name as a file name instead, with an escape for each hiding character and backtick, cut after 200 characters, and in the order of code points.
The engine writes that check name as it is (`engine/tcr.py`), so the two notices differ for a name that holds a hiding character, a backtick or more than 200 characters.
The plugin keeps the stronger escape, since a line break in a raw name could start a line.
The notice of a held edit also words a check that outlived its deadline differently: the engine says that it "outlived its deadline and says nothing of the edit" only when every held check outlived its deadline, and for a mixed set says that the checks "failed and has no earlier result to compare with" (`engine/tcr_texts.py`), and the plugin says that a check "gave no result to judge by", as it does for each check that gave none (`hooks/judgement.ts`).
Both hold the edit, and no test compares the two words.
`tests/tcr-names-in-notices.test.ts` pins both notices with literal names.
An escape is `\xNN`, `\uNNNN` or, above the basic plane, `\UNNNNNNNN`, so a check, a file or a directory cannot start a line the agent reads as Overwatch's own, and a file name cannot end the quotes around it.
The test `tests/forged-lines.test.ts` puts hostile text in every input of each builder.
`tests/test_hook_text_builders.py` finds the functions of `hooks/` that build a text by reading their source with a tokenizer, and fails for one that is in neither the test's matrix nor its list of those with no text to write.
It reads functions declared with `function`, as a function expression held by a `const`, arrows, getters, static methods, methods of classes and objects, arrows held by object properties, expression bodies and templates in parameter defaults, and a text built with a template, a join, a replace, a concat, `padStart`, `padEnd`, `repeat`, `toString`, `JSON.stringify`, `String`, a `reduce` that adds without an initial value or starts from a string, a `+` beside a variable named for text, or `+=` of anything that is not a number onto any variable.
It does not read an arrow with one parameter and no parentheses, a text built by another function that the function calls, an immediately invoked arrow outside any function, a `+` of two variables whose names do not say text, as `first + second`, a `slice`, which an array has too, or two methods of one name in one file, which it takes for one function; the test pins each as a miss, so one that is fixed fails it until this list changes.
A reason in the list of functions with no text to write is checked: the function exists and holds no assert over text that can fail on it.
No assert of `hooks/` may look at a text that a file, a check or a summary gave, since such an assert raises on a correct run, and after a revert it replaces the notice of the revert.
A result that arrives after its session ended is dropped, so it cannot change what the next session takes the project to have been when it began; a gate that a failing check guards stays on after a resume.
The timers of a watcher and of an edit are cancelled when the session ends, and a result they deliver late changes nothing.
`tests/tcr-resume-steps.test.ts` resumes a session in place with each step of the host throwing in turn, and expects the guarded edit to be denied afterwards.
One step is excepted: a watcher whose process cannot start waits 30 seconds before it is tried again, and the gate holds nothing meanwhile.
The agent is told once that it exited, at the start of the next turn, and `tests/tcr-resume-steps.test.ts` expects that notice at this step.
`tests/test_timer_guards.py` lists each `$.clock.after` call of `hooks/` by its file and first argument and names the test of `tests/late-paths.test.ts` that ends the session or the work and then looks at the timer; it fails for a call it does not list, for a different number of calls under a key than its list holds, for a test that is gone, and for a test whose body has no `expect(` or no call of the function it names.
Each test was run against the code with the guard it covers removed, one guard at a time, on the last commit of the change, and failed: the check that a result of an earlier session changes nothing in `deliver`, the cancel of the flush, the cancel of the quiet timers, the epoch of the restart and of its timer, of the rerun, and of the exit toast, and the check of `runOnce` that its watcher still watches.
That run is by hand and no check of CI repeats it (unverified in CI); the check of `tests/test_timer_guards.py` is only that each named test calls the function and holds an `expect(`.
Two timers have no such test, because no fake host fires them after the end of a session:
the `register.ts` timer `0` runs the search for watchers after a resume, which does nothing when the session has no directory; the `judgement.ts` timer `limit` that `judgeTcr` starts is the watchdog of a judgement, whose stop compares the session and the ticket.
The other `judgement.ts` timer `limit`, in `noteFilesBefore`, bounds the comparison of the files; the fake host does fire it after the end of a session, in `tests/tcr-ended-session.test.ts`, and `tests/test_timer_guards.py` checks that this test exists and calls `noteFilesBefore`.
It does not tell whether that line is enough; `tests/tcr-resume.test.ts` plays three sessions in a row over the gate.
The host may start the next session before the end of the last one returns; it is not known whether Claude Code does (unverified).
The plugin counts a session that starts while no directory is set as a new one, which is the case after an end that is no resume and while the end of a resume still waits, so that what the old session still does is dropped: its search, its notes of HEAD, its notices and its status.
A session that starts after the end of a resume already set the directory continues that session and keeps its watchers; `tests/tcr-overlap-guards.test.ts` plays both cases in a few seconds, and fails when the bump is removed or made for every start, or when the check of the session in `stop` or in the end of a resume is removed.
`tests/tcr-session-overlap.test.ts` plays a new session that starts in a gap of 0, 20 and 150 ms after the call that ended the last, and while the old session's search is slow, and expect the agent of the new session to be told that TCR is on, once, and no error, and its first edit to be committed.
A gap of more than 150 ms is not played (limit).
`tests/test_hook_text_asserts.py` finds each assert whose condition looks at text, fails for one that is not in its list with the reason it cannot fail on such text, and fails for any in a function that runs after a revert.
It decides that an assert looks at text by the text methods and the words such as `message`, `text` and `summary` in its condition, by a comparison with an empty string, and not by a type test; it finds a length over a name for text or a function's result, and every assert over a length in a function that runs after a revert or before a tool, each of which its list gives a reason; it does not find an assert over text held in a variable of another name, a length of such a variable outside those functions, one that a function of the project makes yes or no, or a check made with a function other than `assert`; the test pins each as a miss.
`tests/tcr-hostile-sentences.test.ts` writes every fixed sentence of the notices into a file name, a check name and a summary in a revert that was done, failed or of unknown end, and asserts only that the agent is told one notice that opens as that revert does; it does not compare the rest of the text.
`tests/test_hook_text_builders.py` also checks that the fixture of those sentences is current with the sentences of the builders.
`tests/gating-hostile.test.ts` gives the parser of the agent's command the same sentences and a pseudo-random mix of quotes and operators, which the asserts of `hooks/gating.ts` over that text rely on.
Every entry the host calls into the plugin, a hook, a timer or a watcher's callback, runs inside the boundary of `hooks/boundary.ts`: an error nobody expected there is told to the agent, stops TCR where it runs, and goes on, rethrown where a caller waits for the entry and written to the host's log where none does.
The gate and the end of a turn hold a call only for the normal decision: valid settings, a protected tool and a failing check.
An error there never holds a call or the end of a turn, since the agent cannot always clear its cause: the call runs and the turn ends, and the agent is told once.
The part of an editing tool's call after the tool ran is open the same way: an error there tells the agent and writes the host's log, and the call returns the tool's result.
An error nobody expected is also written to the host's log.
`tests/tcr-net-entries.test.ts`, `tests/tcr-net-gates.test.ts`, `tests/tcr-net-stops.test.ts` and `tests/tcr-net-turns.test.ts` make the host throw at each step of the plugin's calls of the host in seven entries over four files, one run for each step, and fail when a run that left the project or the entry's answer other than the run without a throw tells the agent nothing new.
Each run starts a session cold, as the first session of a project does.
The end of a turn is swept by three tests that each play a third of the steps.
`tests/tcr-boundaries.test.ts` does the same for each step after the revert command was asked, for twelve answers of the command.
It names, for each answer, the exact number of steps after the command was asked and whether the answer is told as a revert (its reset is done) or as a try.
A failing answer that throws nothing pauses TCR with "TCR is unavailable" and no unexpected error; a throw of a process is the command failing; only a throw of another step may go on as an error of the plugin's own.
`tests/tcr-net-edit-marks.test.ts` makes the host throw at each step after an editing tool ran, and expects that the failure which the first result after the edit holds is still told.
Each sweep names, as a number in its file, the exact number of steps its plain run makes; the fixture fails a sweep that makes another number of steps, plays another number of runs, or runs its check any other number of times than once for the plain run and once for each run played.
`tests/test_sweeps_ran.py` fails a file that sweeps with no such number, a call of `sweep(` (with or without type arguments) that does not name `steps` once in its own arguments as an integer literal, and an entry of a sweep that names none; a number such as `6 * 2` or `12.5` is no literal, and a line of the fixture that is commented out does not count; `tests/tcr-net-sweep-floor.test.ts` plays the fixture with a number that is wrong, which it fails, and with the right one, and shows that a sweep gives its check the plain run and each run it plays, for even steps and for odd steps.
A file that calls neither `sweep` nor `sweepEntries` is held to one integer literal of `steps` in the file and not to one for each shape; a `steps:` in a nested object of the call, and a call under another name for `sweep`, are not told from the number (limits, unverified).
`tests/test_hook_epoch_asserts.py` fails an assert over `state.tcr`, `state.outbox`, `state.liveWatchers`, `state.head`, `state.isPromptQueued` or `state.isTurnRunning` that follows an await in its function, does not name the session and has no guard between: an `if` that leaves when the session differs, or the statement under an `if` that names the same session; it reads a function with no `epoch` of its own and a name made by `const name = state`.
`tests/test_hook_queue_epochs.py` does the same for a call that queues a message or pauses TCR; as a guard it accepts only a comparison of the current `epoch` or TCR state with a captured one, or a call of `isJudging`, in a block that holds the call, joined to nothing by `&&` where it leaves and by `||` where it acts and not negated as a group, as in `!(state.epoch !== epoch)`, and a `tellUnexpected` given the plain captured `epoch`.
The assert scan pins, as literal numbers, how many asserts it reads; the queue scan pins how many declarations and how many calls of the names it lists it reads, as two numbers.
These numbers, and the number of steps each sweep names, are snapshots that catch a change, not proofs that a scan or a sweep finds all it should; a changed number is set again by hand after a look at the change.
Both read one function at a time, so a call that only a caller guarded is not found (limit).
The queue scan reads a wrapper such as `holdTcr`, `checkpointTcr`, `noteBranch` or `activeSettings` for its own calls only, and `judgeChecks` reaches `actOnJudgement` guarded by the callee alone; it does not tell whether the captured value is the right one; it reads a `.then(...)` in a function with no `await` as no wait, and a call a loop repeats once; it does not scan a call through an alias, with `?.()` or as `module.name()`, nor a name outside its list, which holds `$.prompt.submit`, `$.ui.toast` and `state.outbox.set` (limits, unverified where no example was run).
The toast after the note of HEAD in the checkpoint is shown to the user, queues nothing for an agent and names a commit that was made.
The assert scan counts an assert as naming the session when its condition holds the word `epoch`, a call of `isJudging` or the comparison of the TCR state (limit).
`tests/test_watchers_end_with_session.py` fails a plugin test that starts a session, gives it a `process.spawn` hook that loops over `clock.sleep` or waits on a promise, and never ends the session.
Its limits: it reads the hook written in the test and not a watcher that a fixture gives, and nine tests that use `tcrProject` start a session and do not end it.
These scans read the source with a tokenizer; what they do not find is not listed (unverified).
Their limits: a call of `$.clock.after` and a call of `$.ui.status` are not stepped, since the test kit lets one hook answer the clock and a throwing status hook ends the host's chain of the plugin's hooks, which the test cannot tell from a failure of the plugin; a throw that the plugin handles as a failure of the checkpoint command, which `runWithin` does for each call of the host in a process, is not reached by the revert boundary, which only a bug in the plugin's own code reaches.
`tests/test_hook_swallowed_errors.py` fails a `.catch(` handler (an arrow function with or without parentheses around its parameter), a second argument of `.then(`, an empty `catch` (one that holds only a comment too) and a `catch` that only returns a literal in `hooks/`, when it turns a failure into nothing and the table of the test gives no reason.
It fails too when the table names a handler that `hooks/` no longer has, or in another number.
It reads `undefined`, `null`, `[]`, `{}`, a boolean, a number, a string, an upper-case name, `void 0` and `Promise.resolve()` as nothing, also in parentheses or with `as` and a type, in an arrow function, in a function expression, and in a block that holds only a bare `return` or a `return` of one of them.
It does not see a handler that is a named function or a call such as `orElse(undefined)` or `noop()`, a handler that returns `Promise.resolve(undefined)` or another call, a swallow through an alias or through `Promise.allSettled`, or a swallow outside `hooks/`.
It does not judge whether a reason in the table is good, and the test pins four of these as misses (limits).

The plugin runs `engine/checkpoint.py` with `python3`, which must be on `PATH`, to compare files, commit and revert; without it TCR is unavailable and says why.
A question to it has a limit of 20 seconds, a commit or a revert two minutes, a check nine minutes and a whole judgement 13 minutes, and past a limit TCR is unavailable.
`tests/tcr-limits-pinned.test.ts` pins each of these limits and each count of a notice with literal numbers, so that a changed limit fails a test.
`OVERWATCH_TCR_TIMEOUT_SCALE`, a number above zero in the environment of the session, multiplies every limit above, except the 10 seconds a stalled look is remembered; no limit becomes longer than 2147483647 milliseconds, the longest a timer waits, and a scale above 2147483647 counts as 2147483647.
The tests set it to wait less, and a value left in the environment shortens every limit, so an interactive session that starts with it set to a number other than one tells the user so.
A value that is not a number, or is zero, negative or infinite, changes no limit and tells nothing; `tests/tcr-lifecycle-gaps.test.ts` pins `1e308`, `1e-308`, `NaN`, `Infinity`, `0` and a negative value.
A read of the environment that the host refuses fails as an error named `HooksError`, which is how the host answers a refused or missing variable (checked in the test kit; a real host was not run).
It counts as an expected failure, as a `CommandError` does: every limit keeps its default, the user is told once for the session, a resume of it included, when TCR can run in the project, and the checks and TCR go on; any other failure of the read goes on as an error.
The toast names the variable: `OVERWATCH_TCR_TIMEOUT_SCALE`, which a project without `"mode": "tcr"` is not told of.
The set of toasts shown holds the names `OVERWATCH_TCR_TIMEOUT_SCALE`, `PATH` and `HOME`, so a refusal whose message differs between two reads is still shown once for the session.
A `PATH` that the host refuses is told to the user at the start of the session, once, as that: overwatch may not find the checks.
When TCR then finds no check, the agent is told that `PATH` could not be read, not that no check is configured.
A read of `PATH` that answers after the session resumed pauses nothing in the new session; `tests/tcr-pausing.test.ts` pins that.
A refused `HOME` is told to the user once, as that: the full output of a failed check is not saved.
`tests/tcr-environment.test.ts` pins these with a stub for each kind of error, and with the fake host refusing the variable for a session in which TCR reverts and the checks report.
`tcr.hostLimitSeconds` is checked but does not apply, since the judgement runs beside the agent and not inside a hook.
Neovim has no code that reads `"mode": "tcr"`, so it ignores it; no test pins that (unverified).

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

Restart Codex, run `/hooks`, and trust the Overwatch hooks.
Codex requires renewed trust whenever a hook definition changes.

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

Pi asks you to trust project-local extensions before loading them.
In non-interactive runs, pass `--approve` or save the trust decision.

### Neovim

```lua
vim.pack.add({ "https://github.com/benomahony/overwatch" })
```

The dedicated Neovim guide covers the quickfix list, status line, and commands.

## Neovim

The same test watchers run beside Neovim (zanity does not; its own `zanity lsp` gives Neovim its findings on save): the full suite first, then the watcher, with no agent involved.
The latest result of each language's watcher is in `require('overwatch').status()`, every failing build goes into one quickfix list (`:copen`), titled with the watchers whose builds failed and cleared of each one as it goes green.
A watcher with no `argv` reruns `baseline` after every save, stopping a run that a newer save has overtaken.
A watcher that exits is restarted as it is in Claude Code, at once or after 30 and then 60 seconds; after three quick exits in a row it stays stopped, with what it last printed, until `:OverwatchStart`.
It starts with Neovim in a project that has a watcher; `:OverwatchStart` and `:OverwatchStop` start and stop it.

```lua
vim.pack.add({ "https://github.com/benomahony/overwatch" })
require("lualine").setup({ sections = { lualine_x = { require("overwatch").status } } })
```

## Develop

The [behavior guide](https://benomahony.github.io/overwatch/behavior/) is generated from the Given/When/Then scenarios in [the acceptance catalog](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py).
Each implemented step is executable against an isolated repository and the real command hook.
Proposed scenarios are displayed separately and do not count as passing tests.
Generation and CI checks run the implemented scenarios first; failing scenarios cannot publish a verified behavior page.

The test that every read of a file in the engine decodes by a rule, and the one that no assert inspects text, find the shapes a developer writes by accident, such as `getattr(path, "read_text")()`, `read_bytes().decode()`, `notice[:9]`, and `list(sys.stdin)`, `next(iter(sys.stdin))`, `print(*sys.stdin)` and `shutil.copyfileobj(sys.stdin, out)`; they do not find a reader that is named at run time or reached through `operator`, a library that decodes inside (`tomllib`, `subprocess.run(text=True)`, `check_output(encoding="utf-8")`), `sys.stdin` given to a library that reads it (`csv.reader(sys.stdin)`) or to `map` (`map(f, sys.stdin)`), to a function that iterates the stream it is given, or joined into a text (`''.join(sys.stdin)`), or an `except ValueError` in the same function that guards another call.
The test that every read of a file in the engine is made without blocking finds `read_text`, `read_bytes`, `open`, `copyfile`, `file_digest`, `shutil.copy`, `shutil.copy2`, `shutil.copytree`, `fileinput.input`, `fileinput.FileInput`, `filecmp.cmp`, `filecmp.cmpfiles` and `operator.methodcaller` given one of those names; it does not find a reader reached through an alias (`from shutil import copy as duplicate`), a copy made by a method of a path (`p.copy(q)`), `getattr(path, name)` with a name held in a variable, or a command that reads a file (`subprocess.run(['cat', path])`).
Two reads are left as they are: `subprocess.run(text=True)` in `workspace` and `watching`, which decodes strictly and is not found; and `read_event`, where a hook event of bytes that are not UTF-8 on a strict stdin ends in the entry point's handler as `overwatch: unexpected error` with exit 0, which a test pins.
The test that no assert inspects text scans the engine modules of this change (`bugs`, `checkpoint`, `checkpoint_command`, `checkpoint_git`, `repository_state`, `safe_text`, `saved_revert`, `secrets_guard`, `tcr`, `tcr_settings`, `tcr_texts`).
The test does not scan the other engine modules (`daemon`, `discovery`, `engine`, `gating`, `messages`, `reading`, `records`, `running`, `sessions`, `triage`, `unix`, `watching`, `workspace`).
Widening the scan means reading each of them for asserts over text.
`messages` holds asserts over text, and this test does not scan it.
The test that CI runs every test file reads the `run:` of the steps of `test.yml`.
It leaves out comments, `echo`, `printf`, `ls` and `cat` lines, `:` commands, a command followed by `|| true`, `|| :`, `|| exit 0` (with or without a closing `;`), `|| (exit 0)`, `|| (true)`, `|| { true; }`, `|| /bin/true`, `|| echo` or `|| printf`, a command piped into `true` or left in the background by `&`, a command after `false &&`, `exit` or `set +e`, and steps or jobs whose `if:` is literally false (`0`, `${{ !true }}` and `false && ...` too), that set `continue-on-error: true` or that set a `working-directory`.
It reports a workflow that starts only by hand, or only for a push to a branch that is not the default one; it reads only the block style of `on:`.
A command followed by `; true` still counts: the step runs with `bash -e`, so the failure ends it.
It does not follow a matrix, a composite action, a reusable workflow, a script that runs the tests, a glob such as `tests/*.mjs`, a step written in flow style, or a pipeline that starts with `echo` or `cat`, so it reports the files these run as not run.
It counts a file as run when an `if:` is false by an expression, when a job has `needs:` on a job that does not exist, when a step has `if: failure()` or `if: always() && false`, when a job sets `defaults.run.working-directory`, `timeout-minutes: 0`, a runner no one has, a `--test-name-pattern` or `--test-skip-pattern` that matches nothing or every test, when a command sits in a shell `if` that is false or after a `[ .. ] &&` test that is false, when it runs in a pipeline into `tee`, `cat` or `head`, when a step has a `shell:` that is no shell, and when the command sits in the body of a heredoc.
It looks for Node and Lua tests only directly in `tests/`.

Add a scenario by composing `Scenario(...).given(...).when(...).then(...)` with fixture actions for every implemented step.
Titles must be unique.
Use `status="proposed"` with no executable actions for a planned behavior.
Keep hook payloads, temporary paths, and test setup in the fixture rather than the prose.

The [Spec page](https://benomahony.github.io/overwatch/model/) embeds every TLA+ module as TLATeX typesets it, in reading order, with the source's own sections and comments.
The [Behavior page](https://benomahony.github.io/overwatch/behavior/#model-derived-integration-contracts) renders every host contract from the TLC fixtures and supports agent and text filters.

The [behavioral specification](https://github.com/benomahony/overwatch/blob/main/spec/README.md) covers every integration.
`Overwatch.tla` models baselines, workspace versions, buffered builds, and notification ordering.
`IntegrationContract.tla` specifies the six hosts' request/response behavior, independent inspection during checks, scoped guards, completion feedback, delivery, and lifecycle.
Both layers share `FailurePolicy.tla`.
Host differences are explicit: OpenCode 1 warns at idle, Pi continues, OpenCode 2 queues a correction, Codex and Claude guard completion, and Neovim has no agent gates.

TLC computes the expected observations for the result and host-contract replays; CI rejects stale generated fixtures.
The replays exercise production hooks, native callbacks, real shared-checker processes, held session locks, and Neovim watcher callbacks.
The spec documents the model bounds, composition assumptions, and each host's observable channels.

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
python3 scripts/spec_latex.py --jar /path/to/tla2tools.jar --check  # typeset every module for the PDF downloads; needs pdflatex
python3 scripts/markdown_format.py  # put each sentence of the Markdown in git on a line of its own; --check only lists
python3 scripts/timing.py gaps    # fit the gaps between edits in your Claude Code transcripts
python3 scripts/timing.py budget --first 300  # longest rerun time for a 10% slowdown at each max-ahead
```
