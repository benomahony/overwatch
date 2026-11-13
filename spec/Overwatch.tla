---------------------------- MODULE Overwatch ----------------------------
(* Section: Imports

Shared operators used by this module are imported below.
*)
EXTENDS Naturals, FiniteSets, Sequences, FailurePolicy

(* Section: State and result domains

Workspace versions, completed outcomes, and message records form the result layer.
Finite bounds are supplied by the TLC configuration, not by the runtime.
*)
CONSTANTS Names, MaxEdits, Timeout, TcrMode
ASSUME "timeout" \notin Names /\ TcrMode \in BOOLEAN

Versions == 0..MaxEdits
Results == SUBSET Names
TimedOut == "timeout"
Outcomes == SUBSET (Names \cup {TimedOut})
NoMessage == [held |-> FALSE, waking |-> FALSE, failures |-> {}]
NotTold == [kind |-> "none", fresh |-> {}]

(* Section: State shape

The checked version, unread results, inherited baseline, and delivery state are
separate. TypeOK constrains their domains without advancing an execution.
*)
VARIABLES
    truth, head, based, busy, from, quiet, installed,
    produced, consumed, pending, report, baseline, wasFailing,
    outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
    tcr, ck, person, settleDue, noticePending, noticeCause, noticeTold

vars == <<truth, head, based, busy, from, quiet, installed,
          produced, consumed, pending, report, baseline, wasFailing,
          outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
          tcr, ck, person, settleDue, noticePending, noticeCause, noticeTold>>
tcrVars == <<tcr, ck, person, settleDue, noticePending, noticeCause, noticeTold>>

TypeOK ==
    /\ truth \in [Versions -> Results]
    /\ head \in Versions /\ based \in 0..head
    /\ busy \in BOOLEAN /\ from \in Versions /\ quiet \in BOOLEAN /\ installed \in BOOLEAN
    /\ produced \in 0..(MaxEdits + 1) /\ consumed \in 0..produced
    /\ pending \in Seq([id : 1..(MaxEdits + 1), at : Versions, failures : Outcomes])
    /\ Len(pending) <= MaxEdits + 1
    /\ report \in [known : BOOLEAN, id : 0..produced, at : Versions, failures : Outcomes]
    /\ baseline \in [known : BOOLEAN, failures : Outcomes]
    /\ wasFailing \in BOOLEAN
    /\ outbox \in [held : BOOLEAN, waking : BOOLEAN, failures : Outcomes]
    /\ told \in [kind : {"none", "failed", "recovered"}, fresh : Outcomes]
    /\ flush \in BOOLEAN
    /\ turn \in {"idle", "running"}
    /\ toldThisTurn \in BOOLEAN /\ promptQueued \in BOOLEAN
    /\ knows \in Outcomes /\ elapsed \in 0..Timeout
    /\ edited \in BOOLEAN
    /\ tcr \in {"off", "active", "unavailable"} /\ ck \in Versions /\ ck <= head
    /\ person \in {"none", "unseen", "seen"} /\ settleDue \in BOOLEAN
    /\ noticePending \in BOOLEAN /\ noticeCause \in Outcomes /\ noticeTold \in Outcomes

(* Section: Failure gating

A failure report becomes a gate only when it is a regression against the
session baseline, or when the check times out.
*)
Failing == report.known /\ report.failures # {}
Regressed(f) == TimedOut \in f \/ (baseline.known /\ NewFailure(f, baseline.failures))
Guard == Failing /\ Regressed(report.failures)
Clean == person = "none" /\ ck = head

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
    /\ baseline = [known |-> FALSE, failures |-> {}]
    /\ wasFailing = FALSE
    /\ outbox = NoMessage /\ told = NotTold /\ flush = FALSE
    /\ turn = "idle" /\ toldThisTurn = FALSE /\ promptQueued = FALSE
    /\ knows = {} /\ elapsed = 0 /\ edited = FALSE
    /\ person \in IF TcrMode THEN {"none", "seen"} ELSE {"none"}
    /\ tcr = IF ~TcrMode THEN "off" ELSE IF person = "none" THEN "active" ELSE "unavailable"
    /\ ck = 0 /\ settleDue = FALSE
    /\ noticePending = FALSE /\ noticeCause = {} /\ noticeTold = {}

(* Section: Result delivery and baseline isolation

Queue deduplicates notification signatures. Deliver consumes a completed
snapshot, establishes the inherited baseline, and queues a regression or recovery.
A recovery can cancel a failure message that has not yet been delivered.
*)
Queue(signature, message) ==
    IF told = signature /\ ~outbox.held
    THEN UNCHANGED <<outbox, told, flush>>
    ELSE /\ told' = signature /\ outbox' = message /\ flush' = TRUE

Deliver(v, id, f) ==
    LET b == IF baseline.known THEN baseline.failures ELSE IF head = based THEN f ELSE {}
        isRegression == TimedOut \in f \/ ~(f \subseteq b)
    IN /\ report' = [known |-> TRUE, id |-> id, at |-> v, failures |-> f]
       /\ baseline' = IF TimedOut \in f THEN baseline ELSE [known |-> TRUE, failures |-> b]
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
following the agent's own change. Another process can change the workspace at
any time without committing; OutsideEdit advances head the same way but marks
nothing. An external head change moves both and invalidates the baseline and
unread results. QuietElapses starts the next check; Tick advances its timeout clock.
*)
Edit ==
    /\ turn = "running" /\ head < MaxEdits
    /\ head' = head + 1 /\ quiet' = TRUE /\ edited' = TRUE
    /\ settleDue' = (settleDue \/ tcr = "active")
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, tcr, ck, person,
                   noticePending, noticeCause, noticeTold>>

OutsideEdit ==
    /\ head < MaxEdits
    /\ head' = head + 1 /\ quiet' = TRUE
    /\ person' = IF TcrMode /\ person = "none" THEN "unseen" ELSE person
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, settleDue,
                   noticePending, noticeCause, noticeTold>>

HeadMoves ==
    /\ head < MaxEdits
    /\ TcrMode => (person = "none" /\ ck = head)
    /\ head' = head + 1 /\ based' = head + 1
    /\ ck' = IF TcrMode THEN head + 1 ELSE ck
    /\ baseline' = [known |-> FALSE, failures |-> {}]
    /\ quiet' = TRUE /\ pending' = <<>>
    /\ from' = IF busy THEN head + 1 ELSE from
    /\ elapsed' = IF busy THEN 0 ELSE elapsed
    /\ UNCHANGED <<truth, busy, installed, produced, consumed, report, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited, tcr, person,
                   settleDue, noticePending, noticeCause, noticeTold>>

QuietElapses ==
    /\ quiet /\ installed
    /\ quiet' = FALSE /\ busy' = TRUE /\ from' = head /\ elapsed' = 0
    /\ UNCHANGED <<truth, head, based, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, edited, tcrVars>>

Tick ==
    /\ busy /\ elapsed < Timeout /\ elapsed' = elapsed + 1
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   consumed, pending, report, baseline, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited, tcrVars>>

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
                   tcrVars>>

RunEnds == busy /\ \E v \in from..head : Buffer(v, truth[v])
TimesOut == busy /\ elapsed = Timeout /\ Buffer(from, {TimedOut})

ReadResults ==
    /\ pending # <<>>
    /\ LET latest == pending[Len(pending)]
       IN Deliver(latest.at, latest.id, latest.failures)
    /\ consumed' = produced /\ pending' = <<>> /\ edited' = FALSE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   turn, toldThisTurn, promptQueued, knows, elapsed, tcrVars>>

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
                   pending, report, baseline, wasFailing, told, turn, elapsed, edited, tcrVars>>

TurnStarts ==
    /\ turn = "idle" /\ turn' = "running"
    /\ toldThisTurn' = promptQueued /\ promptQueued' = FALSE /\ flush' = TRUE
    /\ tcr' = IF tcr = "off" THEN "off" ELSE IF Clean THEN "active" ELSE "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, knows, elapsed, edited,
                   ck, person, settleDue, noticePending, noticeCause, noticeTold>>

WokenTurnStarts == promptQueued /\ TurnStarts

TurnCompletes ==
    /\ turn = "running"
    /\ IF Guard
         THEN /\ toldThisTurn' = TRUE /\ knows' = report.failures /\ UNCHANGED <<turn, flush>>
         ELSE /\ turn' = "idle" /\ flush' = TRUE /\ UNCHANGED <<toldThisTurn, knows>>
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, promptQueued, elapsed, edited,
                   tcrVars>>

(* Section: TCR mode

With TcrMode, an edit of the agent is settled once a result for the current
workspace has been read: a green result commits the workspace as the new
restore point ck, and a result with a new failure restores the workspace to
the restore point. A revert is a new workspace version, so head only grows,
and its content is that of the restore point. A pull replaces the restore point.
A person's uncommitted work is unseen after an outside edit and seen once a
tool that does not edit follows it, or when it was there at the start; TCR
then waits until the person commits it. A check that timed out cannot judge an
edit. The notice of a revert is kept apart from the failure message, so the
recovery that a revert causes cannot cancel it. A pull with uncommitted work
and the instant in which a hook edits and settles are outside this abstraction:
a turn may start before the result of an edit is read, and TCR then waits.
*)
Judged == tcr = "active" /\ settleDue /\ report.known /\ report.at = head
          /\ TimedOut \notin report.failures
FreshFailures == report.failures \ baseline.failures

Observe ==
    /\ tcr = "active" /\ person = "unseen" /\ ~settleDue
    /\ person' = "seen" /\ tcr' = "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, settleDue,
                   noticePending, noticeCause, noticeTold>>

PersonCommits ==
    /\ tcr = "unavailable"
    /\ ck' = head /\ person' = "none" /\ settleDue' = FALSE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr,
                   noticePending, noticeCause, noticeTold>>

Checkpoint ==
    /\ Judged /\ ~Guard
    /\ ck' = head /\ settleDue' = FALSE /\ person' = "none"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr,
                   noticePending, noticeCause, noticeTold>>

CheckpointFails ==
    /\ Judged /\ ~Guard
    /\ tcr' = "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, person,
                   settleDue, noticePending, noticeCause, noticeTold>>

Revert ==
    /\ Judged /\ Guard /\ person # "seen"
    /\ head < MaxEdits /\ truth[head + 1] = truth[ck]
    /\ head' = head + 1 /\ ck' = head + 1 /\ quiet' = TRUE
    /\ settleDue' = FALSE /\ person' = "none"
    /\ noticePending' = TRUE
    /\ noticeCause' = IF noticePending THEN noticeCause \cup FreshFailures ELSE FreshFailures
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn, toldThisTurn,
                   promptQueued, knows, elapsed, edited, tcr, noticeTold>>

TellRevert ==
    /\ noticePending
    /\ noticePending' = FALSE /\ noticeTold' = noticeCause
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, person,
                   settleDue, noticeCause>>

(* Section: Allowed executions and fairness

Next chooses an enabled transition. Spec permits stuttering and requires
weak fairness for the listed progress actions; this does not impose deadlines.
*)
Next == Edit \/ OutsideEdit \/ HeadMoves \/ QuietElapses \/ Tick \/ RunEnds \/ TimesOut
        \/ ReadResults \/ Flush \/ TurnStarts \/ TurnCompletes
        \/ Observe \/ PersonCommits \/ Checkpoint \/ CheckpointFails \/ Revert \/ TellRevert

Spec ==
    /\ Init /\ [][Next]_vars
    /\ WF_vars(QuietElapses) /\ WF_vars(Tick) /\ WF_vars(TimesOut)
    /\ WF_vars(ReadResults) /\ WF_vars(Flush)
    /\ WF_vars(WokenTurnStarts) /\ WF_vars(TurnCompletes) /\ WF_vars(TellRevert)

(* Section: Safety and progress properties

Results retain their ordering and checked version. The baseline cannot
absorb later edits. A failure wakes the agent only when its read follows the
agent's own edit, or when the check timed out, so another process's changes
never wake it. Under Spec fairness, checks end, and each regression reaches
the agent or waits, without waking it, for its next turn.
These properties are model-checked within the committed configuration bounds.
*)
BufferedResultsAreOrdered ==
    /\ \A i \in 1..Len(pending) : pending[i].id > consumed /\ pending[i].id <= produced
    /\ \A i \in 1..(Len(pending) - 1) : pending[i].id < pending[i+1].id

ReadsSelectLatestComplete == report.known => report.id = consumed
ResultsMatchBuilds == report.known => report.failures = truth[report.at] \/ report.failures = {TimedOut}
BaselineNeverAbsorbsEdits == baseline.known => baseline.failures \subseteq truth[based]
RunsEnd == busy ~> ~busy
EveryEditIsChecked == <>[](report.known /\ report.at = head)
Regressions == truth[head] \ truth[based]
WaitsForTurn == turn = "idle" /\ outbox.held /\ ~outbox.waking /\ Regressions \subseteq outbox.failures
RegressionsReachAgent == <>[](Regressions \subseteq knows \/ TimedOut \in knows \/ WaitsForTurn)
OutsideChangesNeverWake ==
    [][told' # told /\ told'.kind = "failed" /\ outbox'.waking
        => edited \/ TimedOut \in outbox'.failures]_vars

(* Section: TCR properties

A revert never discards work of a person that was there at the start or that
a tool that does not edit has seen. Work of a person that no such tool has
seen, because it came just before the agent's edit, cannot be told from the
agent's and a revert discards it: this is a limit, not a property. A commit settles only a green result of the
latest edit, a revert only a result with a new failure of the latest edit, and
neither acts on an overtaken result, a check that timed out, or while TCR is
unavailable. A failed commit changes nothing, so no work is lost. The restore
point is never older than the baseline, and the notice of every revert reaches
the agent.
*)
SeenWorkPausesTcr == person = "seen" => tcr # "active"
RestorePointIsNotOlderThanBaseline == ck >= based
NoticeNamesNewFailures == noticePending => noticeCause # {} /\ TimedOut \notin noticeCause
HeadOnlyGrows == [][head' >= head]_vars
RevertNeverDiscardsSeenWork == [][Revert => person # "seen"]_vars
RevertRestoresCheckpointContent == [][Revert => truth[head'] = truth[ck]]_vars
RevertFollowsNewFailure == [][Revert => NewFailure(report.failures, baseline.failures)]_vars
CheckpointFollowsGreenResult ==
    [][Checkpoint => report.known /\ ~Guard /\ TimedOut \notin report.failures]_vars
OvertakenResultsNeverSettle ==
    [][(Checkpoint \/ CheckpointFails \/ Revert) => report.at = head]_vars
UnavailableTcrChangesNothing ==
    [][tcr # "active" => ~(Checkpoint \/ CheckpointFails \/ Revert)]_vars
FailedCommitLosesNothing ==
    [][CheckpointFails => head' = head /\ ck' = ck /\ person' = person /\ settleDue' = settleDue]_vars
RestorePointMovesWithCommits ==
    [][ck' # ck => (Checkpoint \/ Revert \/ HeadMoves \/ PersonCommits)]_vars
RevertRaisesNotice == [][Revert => noticePending']_vars
RevertNoticeTellsTheCause ==
    [][TellRevert => noticeTold' = noticeCause /\ noticeTold' # {}]_vars
RevertNoticeIsNeverDropped == [][(noticePending /\ ~noticePending') => TellRevert]_vars
RevertNoticeReachesAgent == noticePending ~> ~noticePending
=============================================================================
