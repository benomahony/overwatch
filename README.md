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
The agent is told during a turn whenever the watcher exits, and woken with what the watcher last printed when overwatch gives up.
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
A bug in building the text of the message or the answer tells the agent nothing of the revert, and the work is in the saved ref.
The engine's entry point catches `OSError`, `ValueError`, `TypeError`, `KeyError` and `SubprocessError`, as it does for every event: it prints a system message and exits 0, which a host may not show.
A bug that is none of those, such as an `AssertionError` or a `RuntimeError`, raised before the reset ends the hook with exit code 1, its traceback and nothing on stdout.
After the reset, every error of the kinds above and every such bug is told as the revert with the saved ref, with exit code 0 and the traceback on stderr.
`KeyboardInterrupt`, `MemoryError` and `SystemExit` are not converted, before or after the reset: the hook ends with no JSON, and after the reset the agent is not told the saved ref.
A `KeyboardInterrupt` ends the hook by the interrupt signal, with exit code -2 to a parent that reads the signal and 130 to a shell, and its traceback on stderr; a `MemoryError` exits 1 with its traceback; a `SystemExit(n)` exits n and prints nothing, so a `SystemExit(0)` exits 0 with no output, which a host reads as success; and a SIGTERM ends it with -15 and nothing on stderr.
In none of these cases does anything, stderr included, tell where the saved ref is; list the refs with the command above.
No assert of `tcr` or `tcr_texts` inspects the text of a notice, so a file named like one of its sentences cannot stop the hook.

**What a notice prints of text it does not control.** A file name, a submodule name or a ref is written with an escape for control characters, line and paragraph separators, spaces other than the plain space, format characters such as bidirectional marks and zero-width ones, and backticks, and is cut at 200 characters with `...`; a notice lists at most five of them and then how many more.
A summary or git's own message is written with the same escape, except that it keeps the tab and its backticks, and it is not cut.
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
It cannot tell a person's edit from the agent's when both come before the same edit tool, so do not edit the working tree, or run a second agent in it, while TCR runs.

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
Claude Code does not read the setting yet.
A revert removes empty directories, and a rename that only changes letter case is invisible to it on a case-insensitive filesystem.

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
The test that no assert inspects text scans the engine modules of this change (`bugs`, `checkpoint`, `checkpoint_git`, `repository_state`, `safe_text`, `saved_revert`, `secrets_guard`, `tcr`, `tcr_settings`, `tcr_texts`).
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
