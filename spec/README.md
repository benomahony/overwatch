# Overwatch's behavioral specification

The specification covers Claude Code, Codex, OpenCode 1, OpenCode 2, Pi, and Neovim. Their different host capabilities are explicit contracts, not exceptions in a shared test adapter.

The package reading order is declared once in `modules.json`: shared failure policy, result state machine, host contract, then the lifecycle instance. Documentation and typesetting use that order. Section headings and explanations live in ordinary TLA+ comments in the modules; the published Spec page renders those comments and every mathematical block without a parallel guide.

There are two layers:

- `Overwatch.tla` models workspace versions, inherited baselines, runs, buffered results, and notification ordering. A read consumes the newest completed result, preserves unfinished output, and never makes the agent's edits inherited debt.
- `IntegrationContract.tla` models requests and responses, check contention, selected checks, inherited-finding policy, report delivery, completion feedback, shutdown, and restart. `IntegrationLifecycle.cfg` checks another bounded instance of this same contract with a restart. Both layers use `FailurePolicy.tla`; they do not maintain independent definitions of a regression.

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

The committed model-checking configurations use finite bounds: two checks, a small failure alphabet, up to two requests, and up to one report change or session restart. These bounds exercise concurrency and policy combinations; passing them is not proof for every unbounded program execution or every external host version.

## Model-derived conformance tests

`python3 scripts/model_traces.py --jar /path/to/tla2tools.jar` generates the result-layer traces. `python3 scripts/integration_traces.py --jar /path/to/tla2tools.jar` generates the host contracts. Both scripts contain input programs; TLC computes the expected observations. `model_traces.py` also has TLC walk the result model itself from a fixed seed, taking at each step only an action `Next` enables, and fails unless the walks take every action, timeouts and builds of an older version included; those walks are kept in `tests/fixtures/model-walks.*`, and an integration replays them from the change that makes it follow them. `--check` rejects stale TypeScript or JSON fixtures.

- Claude runs the production `register` hook chain with a controlled host protocol.
- Codex uses real hook processes, commands, and file-backed state, including lock contention.
- OpenCode and Pi run native callbacks through the real shared checker. Held-check requests, deferred context, persistent status, and correction counts are observed at their public callbacks.
- Neovim runs the real watcher callbacks with controlled process I/O, checking status, editor actions, and late callbacks after shutdown.

CI model-checks both layers and the lifecycle instance, verifies generated expectations, and runs all six adapters. Changes should fix code against the contracts. A spec change requires an intentional behavior or capability change, not a workaround for a failing implementation.

## Reading the models

TLA+ describes states and the actions allowed to change them. TLC explores all reachable states within a configuration's finite bounds, including different orders of concurrent events. A failing invariant or temporal property produces a counterexample sequence to investigate before changing the implementation.

In `Overwatch.tla`, `truth` maps workspace versions to findings, `head` is the current version, and `based` identifies the inherited baseline. `pending` holds completed, unread results. `ReadResults` consumes the latest complete result; unfinished process output is outside that action. `outbox` and the turn state constrain when a report becomes visible and whether it can wake an idle agent.

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
