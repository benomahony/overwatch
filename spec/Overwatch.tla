---------------------------- MODULE Overwatch ----------------------------
(* Section: Imports

Shared operators used by this module are imported below.
*)
EXTENDS Naturals, FiniteSets, Sequences, FailurePolicy

(* Section: State and result domains

Workspace versions, completed outcomes, and message records form the result layer.
Finite bounds are supplied by the TLC configuration, not by the runtime.
*)
CONSTANTS Names, MaxEdits, Timeout
ASSUME "timeout" \notin Names

Versions == 0..MaxEdits
Results == SUBSET Names
TimedOut == "timeout"
Outcomes == SUBSET (Names \cup {TimedOut})
NoMessage == [held |-> FALSE, waking |-> FALSE, failures |-> {}]
NotTold == [kind |-> "none", fresh |-> {}]
NoBaseline == [known |-> FALSE, at |-> 0, failures |-> {}]

(* Section: State shape

The checked version, unread results, inherited baseline, and delivery state are
separate. touched records whether the session has edited since the commit the
baseline belongs to; own is the versions those edits made, which only the
properties read. TypeOK constrains their domains without advancing an execution.
*)
VARIABLES
    truth, head, based, busy, from, quiet, installed,
    produced, consumed, pending, report, baseline, wasFailing,
    outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
    touched, own

vars == <<truth, head, based, busy, from, quiet, installed,
          produced, consumed, pending, report, baseline, wasFailing,
          outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
          touched, own>>

TypeOK ==
    /\ truth \in [Versions -> Results]
    /\ head \in Versions /\ based \in 0..head
    /\ busy \in BOOLEAN /\ from \in Versions /\ quiet \in BOOLEAN /\ installed \in BOOLEAN
    /\ produced \in 0..(MaxEdits + 1) /\ consumed \in 0..produced
    /\ pending \in Seq([id : 1..(MaxEdits + 1), at : Versions, failures : Outcomes])
    /\ Len(pending) <= MaxEdits + 1
    /\ report \in [known : BOOLEAN, id : 0..produced, at : Versions, failures : Outcomes]
    /\ baseline \in [known : BOOLEAN, at : Versions, failures : Outcomes]
    /\ wasFailing \in BOOLEAN
    /\ outbox \in [held : BOOLEAN, waking : BOOLEAN, failures : Outcomes]
    /\ told \in [kind : {"none", "failed", "recovered"}, fresh : Outcomes]
    /\ flush \in BOOLEAN
    /\ turn \in {"idle", "running"}
    /\ toldThisTurn \in BOOLEAN /\ promptQueued \in BOOLEAN
    /\ knows \in Outcomes /\ elapsed \in 0..Timeout
    /\ edited \in BOOLEAN
    /\ touched \in BOOLEAN /\ own \subseteq Versions

(* Section: Failure gating

A failure report becomes a gate only when it is a regression against the
session baseline, or when the check times out.
*)
Failing == report.known /\ report.failures # {}
Regressed(f) == TimedOut \in f \/ (baseline.known /\ NewFailure(f, baseline.failures))
Guard == Failing /\ Regressed(report.failures)

(* Section: Initial state

The first check starts at the inherited workspace version. No result or
baseline is known and no notification has been sent.
*)
Init ==
    /\ truth \in [Versions -> Results]
    /\ head = 0 /\ based = 0
    /\ busy = TRUE /\ from = 0 /\ quiet = FALSE /\ installed = FALSE
    /\ produced = 0 /\ consumed = 0 /\ pending = <<>>
    /\ report = [known |-> FALSE, id |-> 0, at |-> 0, failures |-> {}]
    /\ baseline = NoBaseline
    /\ wasFailing = FALSE
    /\ outbox = NoMessage /\ told = NotTold /\ flush = FALSE
    /\ turn = "idle" /\ toldThisTurn = FALSE /\ promptQueued = FALSE
    /\ knows = {} /\ elapsed = 0 /\ edited = FALSE
    /\ touched = FALSE /\ own = {}

(* Section: Result delivery and baseline isolation

Queue deduplicates notification signatures. Deliver consumes a completed
snapshot, establishes the inherited baseline, and queues a regression or recovery.
The first result is the baseline unless the session has edited since the
commit, as another process's changes are inherited like the commit itself; after
a session edit the baseline is empty, so no failure the edit may hold is absorbed.
A recovery can cancel a failure message that has not yet been delivered.
*)
Queue(signature, message) ==
    IF told = signature /\ ~outbox.held
    THEN UNCHANGED <<outbox, told, flush>>
    ELSE /\ told' = signature /\ outbox' = message /\ flush' = TRUE

Deliver(v, id, f) ==
    LET b == IF baseline.known THEN baseline.failures ELSE IF ~touched THEN f ELSE {}
        isRegression == TimedOut \in f \/ ~(f \subseteq b)
    IN /\ report' = [known |-> TRUE, id |-> id, at |-> v, failures |-> f]
       /\ baseline' = IF TimedOut \in f \/ baseline.known THEN baseline
                      ELSE [known |-> TRUE, at |-> v, failures |-> b]
       /\ wasFailing' = isRegression
       /\ IF isRegression
            THEN Queue([kind |-> "failed", fresh |-> f \ b],
                       [held |-> TRUE, waking |-> edited \/ TimedOut \in f, failures |-> f])
          ELSE IF ~wasFailing
            THEN UNCHANGED <<outbox, told, flush>>
          ELSE IF outbox.held
            THEN /\ outbox' = NoMessage /\ told' = NotTold /\ UNCHANGED flush
          ELSE Queue([kind |-> "recovered", fresh |-> {}], [held |-> TRUE, waking |-> FALSE, failures |-> f])

(* Section: Workspace changes and scheduling

An agent edit advances head without moving based, and marks the next read as
following the agent's own change and the session as having edited. Another
process can change the workspace at any time without committing; OutsideEdit
advances head the same way but marks nothing. An external head change moves both,
invalidates the baseline and unread results, and starts the session's edits
afresh. QuietElapses starts the next check; Tick advances its timeout clock.
*)
Edit ==
    /\ turn = "running" /\ head < MaxEdits
    /\ head' = head + 1 /\ quiet' = TRUE /\ edited' = TRUE
    /\ touched' = TRUE /\ own' = own \cup {head + 1}
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed>>

OutsideEdit ==
    /\ head < MaxEdits
    /\ head' = head + 1 /\ quiet' = TRUE
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, touched, own>>

HeadMoves ==
    /\ head < MaxEdits
    /\ head' = head + 1 /\ based' = head + 1
    /\ baseline' = NoBaseline /\ touched' = FALSE /\ own' = {}
    /\ quiet' = TRUE /\ pending' = <<>>
    /\ from' = IF busy THEN head + 1 ELSE from
    /\ elapsed' = IF busy THEN 0 ELSE elapsed
    /\ UNCHANGED <<truth, busy, installed, produced, consumed, report, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited>>

QuietElapses ==
    /\ quiet /\ installed
    /\ quiet' = FALSE /\ busy' = TRUE /\ from' = head /\ elapsed' = 0
    /\ UNCHANGED <<truth, head, based, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, edited, touched, own>>

Tick ==
    /\ busy /\ elapsed < Timeout /\ elapsed' = elapsed + 1
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   consumed, pending, report, baseline, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited,
                   touched, own>>

(* Completion appends a result; it does not deliver it. Partial output is a
   stuttering step at this abstraction: only a complete build enters pending. *)
(* Section: Buffered completion and consumption

Run completion appends a snapshot to pending without publishing it.
ReadResults consumes the newest completed snapshot and clears the buffer.
A later incomplete build does not replace an earlier complete result.
*)
Buffer(v, f) ==
    /\ produced' = produced + 1
    /\ pending' = Append(pending, [id |-> produced + 1, at |-> v, failures |-> f])
    /\ busy' = FALSE /\ installed' = TRUE
    /\ UNCHANGED <<truth, head, based, from, quiet, consumed, report, baseline,
                   wasFailing, outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
                   touched, own>>

RunEnds == busy /\ \E v \in from..head : Buffer(v, truth[v])
TimesOut == busy /\ elapsed = Timeout /\ Buffer(from, {TimedOut})

ReadResults ==
    /\ pending # <<>>
    /\ LET latest == pending[Len(pending)]
       IN Deliver(latest.at, latest.id, latest.failures)
    /\ consumed' = produced /\ pending' = <<>> /\ edited' = FALSE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   turn, toldThisTurn, promptQueued, knows, elapsed, touched, own>>

(* Section: Notification delivery and turn completion

A running turn receives at most one notification before another turn starts.
An idle agent can receive one queued wakeup. Flush publishes eligible messages;
TurnCompletes keeps a guarded turn running and permits a clean turn to settle.
*)
Held == IF turn = "running" THEN toldThisTurn ELSE promptQueued \/ ~outbox.waking

Flush ==
    /\ flush /\ flush' = FALSE
    /\ IF outbox.held /\ ~Held
         THEN /\ outbox' = NoMessage /\ knows' = outbox.failures
              /\ IF turn = "running"
                   THEN toldThisTurn' = TRUE /\ UNCHANGED promptQueued
                   ELSE promptQueued' = TRUE /\ UNCHANGED toldThisTurn
         ELSE UNCHANGED <<outbox, knows, toldThisTurn, promptQueued>>
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, told, turn, elapsed, edited,
                   touched, own>>

TurnStarts ==
    /\ turn = "idle" /\ turn' = "running"
    /\ toldThisTurn' = promptQueued /\ promptQueued' = FALSE /\ flush' = TRUE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, knows, elapsed, edited,
                   touched, own>>

WokenTurnStarts == promptQueued /\ TurnStarts

TurnCompletes ==
    /\ turn = "running"
    /\ IF Guard
         THEN /\ toldThisTurn' = TRUE /\ knows' = report.failures /\ UNCHANGED <<turn, flush>>
         ELSE /\ turn' = "idle" /\ flush' = TRUE /\ UNCHANGED <<toldThisTurn, knows>>
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, promptQueued, elapsed, edited,
                   touched, own>>

(* Section: Allowed executions and fairness

Next chooses an enabled transition. Spec permits stuttering and requires
weak fairness for the listed progress actions; this does not impose deadlines.
*)
Next == Edit \/ OutsideEdit \/ HeadMoves \/ QuietElapses \/ Tick \/ RunEnds \/ TimesOut
        \/ ReadResults \/ Flush \/ TurnStarts \/ TurnCompletes

Spec ==
    /\ Init /\ [][Next]_vars
    /\ WF_vars(QuietElapses) /\ WF_vars(Tick) /\ WF_vars(TimesOut)
    /\ WF_vars(ReadResults) /\ WF_vars(Flush)
    /\ WF_vars(WokenTurnStarts) /\ WF_vars(TurnCompletes)

(* Section: Safety and progress properties

Results retain their ordering and checked version. The baseline cannot absorb
the session's edits: a non-empty baseline is exactly the failures of a version
at or after the commit that no session edit made or preceded. A failure wakes
the agent only when its read follows the agent's own edit, or when the check
timed out, so another process's changes never wake it. Under Spec fairness,
checks end, and each regression, a failure outside the baseline taken, reaches
the agent or waits, without waking it, for its next turn.
These properties are model-checked within the committed configuration bounds.
*)
BufferedResultsAreOrdered ==
    /\ \A i \in 1..Len(pending) : pending[i].id > consumed /\ pending[i].id <= produced
    /\ \A i \in 1..(Len(pending) - 1) : pending[i].id < pending[i+1].id

ReadsSelectLatestComplete == report.known => report.id = consumed
ResultsMatchBuilds == report.known => report.failures = truth[report.at] \/ report.failures = {TimedOut}
BaselineNeverAbsorbsEdits ==
    baseline.known => baseline.failures = {} \/
        /\ baseline.failures = truth[baseline.at] /\ baseline.at >= based
        /\ \A w \in own : w > baseline.at
RunsEnd == busy ~> ~busy
EveryEditIsChecked == <>[](report.known /\ report.at = head)
Regressions == truth[head] \ IF baseline.known THEN baseline.failures ELSE truth[based]
WaitsForTurn == turn = "idle" /\ outbox.held /\ ~outbox.waking /\ Regressions \subseteq outbox.failures
RegressionsReachAgent == <>[](Regressions \subseteq knows \/ TimedOut \in knows \/ WaitsForTurn)
OutsideChangesNeverWake ==
    [][told' # told /\ told'.kind = "failed" /\ outbox'.waking
        => edited \/ TimedOut \in outbox'.failures]_vars
=============================================================================
