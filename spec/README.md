# Overwatch's behavioral specification

The specification covers Claude Code, Codex, OpenCode 1, OpenCode 2, Pi, and Neovim. Their different host capabilities are explicit contracts, not exceptions in a shared test adapter.

The package reading order is declared once in `modules.json`: shared failure policy, result state machine, host contract, then the lifecycle instance. Documentation and typesetting use that order. Section headings and explanations live in ordinary TLA+ comments in the modules; the published Spec page renders those comments and every mathematical block without a parallel guide.

There are two layers:

- `Overwatch.tla` models workspace versions, inherited baselines, runs, buffered results, and notification ordering. A read consumes the newest completed result, preserves unfinished output, and never makes the agent's edits inherited debt. With `TcrMode` it also models TCR: the restore point, a person's uncommitted work, the checkpoint and revert of a settled edit, and the notice of a revert.
- `IntegrationContract.tla` models requests and responses, check contention, selected checks, inherited-finding policy, report delivery, completion feedback, the notice of a TCR revert, shutdown, and restart. `IntegrationLifecycle.cfg` checks another bounded instance of this same contract with a restart. Both layers use `FailurePolicy.tla`; they do not maintain independent definitions of a regression.

Failure atoms represent what a runner exposes: named identities or count slots for summary-only checkers. The model cannot recover identities that the runner does not emit.

The interface model receives completed snapshots from the result layer. This is a composition boundary: it abstracts process bytes and workspace discovery, while the result model abstracts host callbacks. Runtime replays test both sides of that boundary. It is not an automatic refinement proof of the implementation.

## Host contracts

`Capabilities` in `IntegrationContract.tla` defines each host's permission, completion, delivery, status, and wakeup behavior. The published specification renders that definition directly.

[Read the host capability definition](https://benomahony.github.io/overwatch/model/#integrationcontract---capabilities)

Every host must permit unprotected inspection and repair independently of check progress. Protected calls consult only their selected checks; an empty selection means all checks. Inherited findings guard only under the configured `block` policy. Deduplicating a message or correction never releases a failure gate. Completed tool work can permit one fresh correction request for unchanged findings.

The interface model represents notification counters as failure deliveries, not every log line, inherited-backlog notice, or recovery message. Completion decisions, queued corrections, warnings, and idle wakeups are distinct observations. In particular, an OpenCode 1 warning is never recorded as a blocked completion.

Shutdown clears pending delivery and visible status. Old callbacks cannot affect a later session or overwrite a user's quickfix list. Restart creates a fresh baseline and delivery state while retaining project policy. The snapshots and counters in a replay are observed through the host's actual callback or output channel.

## Checked properties and assumptions

The result layer checks result ordering, correspondence to a checked version, baseline isolation, eventual check completion, and eventual reporting of regressions.

The interface layer checks that inspection and repair responses are enabled while a check is held, that those responses are allowed, that host capabilities determine completion feedback, that editor paths never invent agent gates, that pending context is current, that queued corrections are deduplicated, and that closed sessions stay silent. It also checks response and delivery liveness.

Delivery liveness assumes check completion fairness, corresponding to the result layer's `RunsEnd` guarantee, and fair host servicing of report/context callbacks. Inspection does not require that assumption: the responder remains enabled even if a check is still held. The runtime contention tests hold a real command-hook session lock until after inspection returns. The model does not specify a universal wall-clock response deadline.

The TCR properties of `Overwatch.tla` are checked with `TcrMode` on by two configurations. `OverwatchTcr.cfg` checks all of them, including the liveness of the notice of a revert, with one failure name and two workspace edits. `OverwatchTcrReverts.cfg` checks every safety property with three workspace edits, which is the least that fits the scenarios in which a revert meets a person's work: an edit of the agent, an outside edit and a revert need three versions, so `RevertNeverDiscardsSeenWork` cannot fail with two. The properties state that a revert is a new workspace version, so `head` only grows, and restores the content of the restore point; that a checkpoint follows a green result and a revert a new failure of the latest edit, never an overtaken result, a timeout, or a result read while TCR is unavailable; that a pull replaces the restore point; that a person's work seen at the start, or after a tool that does not edit, pauses TCR and is never reverted; that a failed commit changes nothing; and that the notice of every revert is kept and reaches the agent. They also state a limit: work that a person did just before the agent's edit, with no tool that does not edit between them, is unseen, and a revert discards it. A probe that asks for a revert while work of a person is unseen finds that trace with three workspace edits, after about 80,000 states, and finds none with two. `Overwatch.cfg` runs the same module with `TcrMode` off and checks exactly the states it checked before TCR existed.

The notice of a revert is a separate delivery path in `IntegrationContract.tla`. A host that delivers by event tells the agent at once. OpenCode 2 queues the notice for the next model request. A check that finds nothing guarded clears a queued failure, never a queued notice, so a pending notice leaves the queue only by delivery or shutdown, and no notice is delivered twice.

The model of TCR leaves out these behaviors of the hooks, each a known abstraction:

- The inherited-block policy is not modelled. The code holds an edit that leaves an inherited check failing uncommitted, so the next turn start sees a dirty tree and TCR becomes unavailable, and within a turn a later revert goes back to the older checkpoint and discards the held edit.
- A revert that cannot finish is not modelled. In the code TCR becomes unavailable when the revert raises, while the model's `Revert` always succeeds.
- A timed-out check is not modelled as the code treats it. The model counts a timeout as a check that cannot judge an edit, while in the code the hook reports an error and saves no state.
- Tool kinds are not modelled. The code acts only after a tool in `EDITING_TOOLS`, which has `Bash` and the editing tools of each agent but not `exec_command`, while the model has no tool kind and makes `Observe` nondeterministic.
- When TCR is decided again is not modelled for each host. The code decides at `SessionStart` and `UserPromptSubmit`, and Pi and OpenCode 1 send no `UserPromptSubmit`, so a paused TCR never resumes in a session there, while the model resumes at every turn start for every host.
- Parallel hooks are not modelled. The code runs the hooks of one session one at a time under a per-session lock, and the model has no hook, so an edit settles when a result for the current workspace is read.

The committed model-checking configurations use finite bounds: two checks, a small failure alphabet, up to two requests, and up to one report change or session restart. The TCR configurations use one failure name, one tick of the timeout clock, and two or three workspace edits. These bounds exercise concurrency and policy combinations; passing them is not proof for every unbounded program execution or every external host version.

## Model-derived conformance tests

`python3 scripts/model_traces.py --jar /path/to/tla2tools.jar` generates the result-layer traces. `python3 scripts/integration_traces.py --jar /path/to/tla2tools.jar` generates the host contracts. Both scripts contain input programs; TLC computes the expected observations. `--check` rejects stale TypeScript or JSON fixtures.

- Claude runs the production `register` hook chain with a controlled host protocol.
- Codex uses real hook processes, commands, and file-backed state, including lock contention.
- OpenCode and Pi run native callbacks through the real shared checker. Held-check requests, deferred context, persistent status, and correction counts are observed at their public callbacks.
- Neovim runs the real watcher callbacks with controlled process I/O, checking status, editor actions, and late callbacks after shutdown.

CI asks TLC for the expected observations and rejects a fixture that no longer matches them (`model_traces.py --check` and `integration_traces.py --check`), rejects LaTeX that is stale against the sources (`spec_latex.py --check`), and runs all six adapters against those fixtures. CI does not run TLC on every configuration. After a change to a module, run each `.cfg` that names it with TLC, for example `java -cp tla2tools.jar tlc2.TLC -config OverwatchTcr.cfg Overwatch.tla`; the large `IntegrationContract.cfg` needs about 10 minutes and a 10 GB heap. Changes should fix code against the contracts. A spec change requires an intentional behavior or capability change, not a workaround for a failing implementation.

## Reading the models

TLA+ describes states and the actions allowed to change them. TLC explores all reachable states within a configuration's finite bounds, including different orders of concurrent events. A failing invariant or temporal property produces a counterexample sequence to investigate before changing the implementation.

In `Overwatch.tla`, `truth` maps workspace versions to findings, `head` is the current version, and `based` identifies the inherited baseline. `pending` holds completed, unread results. `ReadResults` consumes the latest complete result; unfinished process output is outside that action. `outbox` and the turn state constrain when a report becomes visible and whether it can wake an idle agent.

With `TcrMode`, `Overwatch.tla` adds `tcr` (off, active, or unavailable), `ck` (the version the latest commit holds, which a revert restores), `person` (none, unseen, or seen uncommitted work of a person), `settleDue` (an edit of the agent has no settled result yet), and `noticePending`, `noticeCause` and `noticeTold` (the notice of a revert and the failures it names). `Checkpoint` and `Revert` settle an edit once `report` is a result for the current `head`; `Observe` is the first tool that does not edit after an outside edit.

In `IntegrationContract.tla`, `reports` and `baseline` contain per-check finding sets. `busy` represents an unfinished check. `request` and `reply` separate asking for an action from receiving its decision, so TLC can explore a request arriving during a check. `visible`, `contextPending`, and the delivery counters represent the host's observable channels. `active` and `session` distinguish shutdown from restart. `Capabilities` declares the host differences; it does not offer user-selectable enforcement modes.

An action such as `Respond` describes one transition. A primed variable such as `reply'` is its value after the transition; `UNCHANGED` lists values that the action preserves. `Init` defines possible starting states, and `Next` chooses a permitted action. Invariants hold in every reachable state. Temporal properties describe progress across a sequence of states. Weak fairness (`WF_vars`) rules out indefinitely ignoring an action that remains enabled; it does not impose a response time limit.

The fixture event names correspond to model actions: `RequestInspect`, `RequestRepair`, `RequestPublish`, and `RequestComplete` call `Request` with the corresponding kind; `Respond` answers an enabled request; `Poll` answers only if enabled. `Ack` consumes the reply. `Begin` and `Finish` start and finish a check; the fixture supplies the next snapshot. `Report` updates the visible report and `Deliver` consumes deferred context when pending. `Stop` closes the session and `Restart` starts a fresh one. `Turn` starts a person's turn only when idle, `CorrectionTurn` starts the submitted correction's own turn when one is pending (a person's turn otherwise), `StartTurn` requires an idle turn, and `Work` records completed tool work, which permits a fresh correction only outside a correction's own turn. `OutsideBegin` and `OutsideFinish` run a check on another process's change, which only hosts that notice such changes can replay, and `Outside` is that change in the result-layer traces. `LateFinish` represents a late check callback and has no effect on a closed session. Conditional no-ops are trace-wrapper behavior, not additional model transitions.

The [Behavior page](https://benomahony.github.io/overwatch/behavior/#model-derived-integration-contracts) renders every fixture's input state, events, and TLC observations. These are the same expected observations used by the integration tests, including pending replies and channel-specific counters. The page is generated from the fixture rather than a separately maintained list of expected behaviors.

## Reproducing verification and typesetting

Install Java and obtain `tla2tools.jar` from the TLA+ project. The CI workflow pins the jar version and checksum. Run each configuration separately so that its state directory is isolated:

```sh
java -cp /path/to/tla2tools.jar tlc2.TLC -metadir /tmp/overwatch-results -config spec/Overwatch.cfg spec/Overwatch.tla
java -cp /path/to/tla2tools.jar tlc2.TLC -metadir /tmp/overwatch-hosts -config spec/IntegrationContract.cfg spec/IntegrationContract.tla
java -cp /path/to/tla2tools.jar tlc2.TLC -metadir /tmp/overwatch-lifecycle -config spec/IntegrationLifecycle.cfg spec/IntegrationLifecycle.tla
python3 scripts/model_traces.py --jar /path/to/tla2tools.jar --check
python3 scripts/integration_traces.py --jar /path/to/tla2tools.jar --check
```

The Spec page renders every declaration and definition from every TLA+ module in source order. Its sections and explanations come directly from comments in those files. There is no separate documentation equation catalog. `scripts/model_math.py` extracts the definitions from the TLA+ source and translates their notation into LaTeX; it does not maintain separate copies of the formula bodies. Unsupported notation fails generation. Zine emits the TeX expressions, and the pinned KaTeX build step renders them as equation layouts with accessible MathML and the original TeX attached as an annotation. Release pages need no JavaScript, image viewer, or PDF plugin. Zine's local development server renders the same expressions in the browser using a bundled copy of the pinned KaTeX version; plain `cd docs && zine` works without a separate rendering step or network access. CI compares those annotations against the current source definitions.

For the complete typeset-module downloads, install `pdflatex` (for example, TeX Live's `texlive-latex-base`). TLATeX generates the standalone `.tex` files from the same TLA+ modules. The generator checks alignment and rejects overflowing lines and can refresh the existing PDF downloads from the same source:

```sh
python3 scripts/spec_latex.py --jar /path/to/tla2tools.jar --refresh-pdfs
python3 scripts/spec_latex.py --jar /path/to/tla2tools.jar --check
mkdir -p /tmp/overwatch-typeset
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/overwatch-typeset spec/Overwatch.tex
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/overwatch-typeset spec/IntegrationContract.tex
python3 docs/sync.py --write
python3 docs/sync.py
```

To build the equations into the site, install the pinned renderer in a temporary directory and run the HTML rendering and verification steps after Zine:

```sh
npm install --no-save --prefix /tmp/overwatch-doc-math katex@0.16.22
(cd docs && zine release --force)
KATEX_MODULE=/tmp/overwatch-doc-math/node_modules/katex node scripts/render_model_math.mjs
python3 scripts/check_model_html.py
```

This contributor guide is separate from the published specification. The site generator reads the TLA+ source files themselves and discovers the source, configuration, LaTeX, and PDF downloads from `spec/`. CI verifies the generated LaTeX and fixture expectations, runs the contract replays, and rejects stale site pages. After an intentional model change, regenerate the fixtures and LaTeX, review the resulting PDFs, and run the implementation replays before publishing the docs.
