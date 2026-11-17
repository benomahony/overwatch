---------------------------- MODULE Overwatch ----------------------------
(* Section: Imports

Shared operators used by this module are imported below.
*)
EXTENDS Naturals, FiniteSets, Sequences, FailurePolicy

(* Section: State and result domains

Workspace versions, completed outcomes, and message records form the result layer.
Finite bounds are supplied by the TLC configuration, not by the runtime.
*)
CONSTANTS Names, MaxEdits, Timeout, TcrMode, SaveReverted, StartQueued
ASSUME "timeout" \notin Names /\ TcrMode \in BOOLEAN /\ SaveReverted \in BOOLEAN /\ StartQueued \in BOOLEAN

Versions == 0..MaxEdits
NoHold == MaxEdits + 1
Results == SUBSET Names
TimedOut == "timeout"
Outcomes == SUBSET (Names \cup {TimedOut})
NoMessage == [held |-> FALSE, waking |-> FALSE, failures |-> {}]
NotTold == [kind |-> "none", fresh |-> {}]
NoBaseline == [known |-> FALSE, at |-> 0, failures |-> {}]

(* Section: State shape

The checked version, unread results, inherited baseline, and delivery state are
separate. touched records whether the session has edited since the commit the
baseline belongs to; own is the versions those edits made, which only
BaselineNeverAbsorbsEdits reads, so a configuration that does not check that
property may take WithoutOwn as its view. TypeOK constrains their domains without advancing an execution.
*)
VARIABLES
    truth, head, based, busy, from, quiet, installed,
    produced, consumed, pending, report, baseline, wasFailing,
    outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
    tcr, ck, person, settleDue, notices, noticeTold,
    firstResult, holds, holdTold, held, saved, heldAt,
    touched, own

vars == <<truth, head, based, busy, from, quiet, installed,
          produced, consumed, pending, report, baseline, wasFailing,
          outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
          tcr, ck, person, settleDue, notices, noticeTold,
          firstResult, holds, holdTold, held, saved, heldAt,
          touched, own>>
tcrVars == <<tcr, ck, person, settleDue, notices, noticeTold,
             firstResult, holds, holdTold, held, saved, heldAt>>
WithoutOwn == <<truth, head, based, busy, from, quiet, installed,
                produced, consumed, pending, report, baseline, wasFailing,
                outbox, told, flush, turn, toldThisTurn, promptQueued, knows, elapsed, edited,
                tcrVars, touched>>

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
    /\ tcr \in {"off", "active", "unavailable"} /\ ck \in Versions /\ ck <= head
    /\ person \in {"none", "unseen", "seen"} /\ settleDue \in BOOLEAN
    /\ notices \in Seq(Outcomes) /\ noticeTold \in Seq(Outcomes)
    /\ Len(notices) <= MaxEdits + 1
    /\ firstResult \in BOOLEAN /\ holds \in Seq(Outcomes) /\ holdTold \in Seq(Outcomes)
    /\ Len(holds) <= MaxEdits + 1
    /\ held \in BOOLEAN /\ saved \in Seq(Outcomes) /\ Len(saved) <= MaxEdits
    /\ heldAt \in 0..NoHold
    /\ touched \in BOOLEAN /\ own \subseteq Versions

(* Section: Failure gating

A failure report becomes a gate only when it is a regression against the
session baseline, or when the check times out.
*)
Failing == report.known /\ report.failures # {}
Regressed(f) == TimedOut \in f \/ (baseline.known /\ NewFailure(f, baseline.failures))
Guard == Failing /\ Regressed(report.failures)
Clean == person = "none" /\ ck = head
HeldTreeUnchanged == held /\ heldAt = head /\ person = "none"
Seeded == IF TcrMode /\ StartQueued THEN <<{CHOOSE name \in Names : TRUE}>> ELSE <<>>

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
    /\ person \in IF TcrMode THEN {"none", "seen"} ELSE {"none"}
    /\ tcr = IF ~TcrMode THEN "off" ELSE IF person = "none" THEN "active" ELSE "unavailable"
    /\ ck = 0 /\ settleDue = FALSE
    /\ notices = Seeded /\ noticeTold = <<>>
    /\ firstResult = FALSE /\ holds = Seeded /\ holdTold = <<>>
    /\ held = FALSE /\ saved = <<>> /\ heldAt = NoHold
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
       /\ firstResult' = (TcrMode /\ ~baseline.known)
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
    /\ settleDue' = (settleDue \/ tcr = "active")
    /\ touched' = TRUE /\ own' = own \cup {head + 1}
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, tcr, ck, person,
                   notices, noticeTold, firstResult, holds, holdTold, held, saved, heldAt>>

OutsideEdit ==
    /\ head < MaxEdits
    /\ head' = head + 1 /\ quiet' = TRUE
    /\ person' = IF TcrMode /\ person = "none" THEN "unseen" ELSE person
    /\ UNCHANGED <<truth, based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, settleDue,
                   notices, noticeTold, firstResult, holds, holdTold, held, saved, heldAt, touched, own>>

HeadMoves ==
    /\ head < MaxEdits
    /\ TcrMode => (person = "none" /\ ck = head)
    /\ head' = head + 1 /\ based' = head + 1
    /\ ck' = IF TcrMode THEN head + 1 ELSE ck
    /\ baseline' = NoBaseline /\ touched' = FALSE /\ own' = {}
    /\ held' = FALSE /\ heldAt' = NoHold
    /\ quiet' = TRUE /\ pending' = <<>>
    /\ from' = IF busy THEN head + 1 ELSE from
    /\ elapsed' = IF busy THEN 0 ELSE elapsed
    /\ UNCHANGED <<truth, busy, installed, produced, consumed, report, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited, tcr, person,
                   settleDue, notices, noticeTold, firstResult, holds, holdTold, saved>>

QuietElapses ==
    /\ quiet /\ installed
    /\ quiet' = FALSE /\ busy' = TRUE /\ from' = head /\ elapsed' = 0
    /\ UNCHANGED <<truth, head, based, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, edited, tcrVars, touched, own>>

Tick ==
    /\ busy /\ elapsed < Timeout /\ elapsed' = elapsed + 1
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   consumed, pending, report, baseline, wasFailing, outbox,
                   told, flush, turn, toldThisTurn, promptQueued, knows, edited, tcrVars, touched, own>>

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
                   tcrVars, touched, own>>

RunEnds == busy /\ \E v \in from..head : Buffer(v, truth[v])
TimesOut == busy /\ elapsed = Timeout /\ Buffer(from, {TimedOut})

ReadResults ==
    /\ pending # <<>>
    /\ LET latest == pending[Len(pending)]
       IN Deliver(latest.at, latest.id, latest.failures)
    /\ consumed' = produced /\ pending' = <<>> /\ edited' = FALSE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced,
                   turn, toldThisTurn, promptQueued, knows, elapsed, tcr, ck, person, settleDue,
                   notices, noticeTold, holds, holdTold, held, saved, heldAt, touched, own>>

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
                   tcrVars, touched, own>>

TurnStarts ==
    /\ turn = "idle" /\ turn' = "running"
    /\ toldThisTurn' = promptQueued /\ promptQueued' = FALSE /\ flush' = TRUE
    /\ tcr' = IF tcr = "off" THEN "off" ELSE IF Clean \/ HeldTreeUnchanged THEN "active" ELSE "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, knows, elapsed, edited,
                   ck, person, settleDue, notices, noticeTold, firstResult, holds, holdTold,
                   held, saved, heldAt, touched, own>>

WokenTurnStarts == promptQueued /\ TurnStarts

TurnCompletes ==
    /\ turn = "running"
    /\ IF Guard /\ ~held
         THEN /\ toldThisTurn' = TRUE /\ knows' = report.failures /\ UNCHANGED <<turn, flush>>
         ELSE /\ turn' = "idle" /\ flush' = TRUE /\ UNCHANGED <<toldThisTurn, knows>>
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, promptQueued, elapsed, edited,
                   tcrVars, touched, own>>

(* Section: TCR mode

With TcrMode, an edit of the agent is settled once a result for the current
workspace has been read. A green result commits the workspace as the new
restore point ck, and a result with a new failure restores the workspace to
the restore point; the content that the revert discards is saved apart from the
workspace when SaveReverted, and the workspace is the same either way. A failing
result of a check that has no earlier result, or that was held and has not
passed since, or that timed out, has no baseline to be new against: the edit is held, neither
committed nor reverted, TCR stays on, and the agent is told which failures were
held. A held edit is committed by the next edit whose result passes; at the next
turn start the workspace is not clean, so TCR waits until the person commits.
A commit that fails, or that the guard against secrets and large files refuses,
changes nothing and makes TCR unavailable too. A revert is a new workspace
version with the content of the restore point, so head only grows. A pull
replaces the restore point and ends a hold, since the baseline the edit was held
against is gone. A person's uncommitted work is unseen after an
outside edit and seen once a tool that does not edit follows it, or when it was
there at the start; TCR then waits until the person commits it. A check that
timed out is held like a failing check without an earlier result, because a
check that hung says nothing about the edit, and its failure names no file. The
notices of reverts and of held edits are queues kept apart from the failure
message, so the recovery that a revert causes
cannot cancel them. A pull with uncommitted work and the instant in which a hook
edits and settles are outside this abstraction: a turn may start before the
result of an edit is read, and TCR then waits.
*)
Judged == tcr = "active" /\ settleDue /\ report.known /\ report.at = head
Unproven == report.failures # {} /\ (firstResult \/ held \/ TimedOut \in report.failures)
FreshFailures == report.failures \ baseline.failures
Restored == [v \in Versions |-> IF v = head + 1 THEN truth[ck] ELSE truth[v]]

Observe ==
    /\ tcr = "active" /\ person = "unseen" /\ ~settleDue
    /\ person' = "seen" /\ tcr' = "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, settleDue,
                   notices, noticeTold, firstResult, holds, holdTold, held, saved, heldAt, touched, own>>

PersonCommits ==
    /\ (tcr = "unavailable" \/ held)
    /\ ck' = head /\ person' = "none" /\ settleDue' = FALSE
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr,
                   notices, noticeTold, firstResult, holds, holdTold, held, saved, heldAt, touched, own>>

Checkpoint ==
    /\ Judged /\ ~Guard /\ ~Unproven
    /\ ck' = head /\ settleDue' = FALSE /\ person' = "none" /\ held' = FALSE /\ heldAt' = NoHold
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr,
                   notices, noticeTold, firstResult, holds, holdTold, saved, touched, own>>

CheckpointFails ==
    /\ Judged /\ ~Guard /\ ~Unproven
    /\ tcr' = "unavailable" /\ held' = FALSE /\ heldAt' = NoHold
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, person,
                   settleDue, notices, noticeTold, firstResult, holds, holdTold, saved, touched, own>>

Revert ==
    /\ Judged /\ Guard /\ ~Unproven
    /\ head < MaxEdits
    /\ head' = head + 1 /\ ck' = head + 1 /\ quiet' = TRUE
    /\ truth' = Restored
    /\ saved' = IF SaveReverted THEN Append(saved, truth[head]) ELSE saved
    /\ settleDue' = FALSE /\ person' = "none"
    /\ notices' = Append(notices, FreshFailures)
    /\ UNCHANGED <<based, busy, from, installed, produced, consumed, pending,
                   report, baseline, wasFailing, outbox, told, flush, turn, toldThisTurn,
                   promptQueued, knows, elapsed, edited, tcr, noticeTold,
                   firstResult, holds, holdTold, held, heldAt, touched, own>>

Hold ==
    /\ Judged /\ Unproven
    /\ held' = TRUE /\ settleDue' = FALSE /\ heldAt' = head
    /\ holds' = Append(holds, report.failures)
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, person,
                   notices, noticeTold, firstResult, holdTold, saved, touched, own>>

RevertAborts ==
    /\ Judged /\ Guard /\ ~Unproven /\ head < MaxEdits
    /\ tcr' = "unavailable"
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, person, settleDue,
                   notices, noticeTold, firstResult, holds, holdTold, held, saved, heldAt, touched, own>>

TellRevert ==
    /\ notices # <<>>
    /\ notices' = <<>> /\ noticeTold' = notices
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, person,
                   settleDue, firstResult, holds, holdTold, held, saved, heldAt, touched, own>>

TellHold ==
    /\ holds # <<>>
    /\ holds' = <<>> /\ holdTold' = holds
    /\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,
                   pending, report, baseline, wasFailing, outbox, told, flush, turn,
                   toldThisTurn, promptQueued, knows, elapsed, edited, tcr, ck, person,
                   settleDue, notices, noticeTold, firstResult, held, saved, heldAt, touched, own>>

Settle == Checkpoint \/ CheckpointFails \/ Revert \/ RevertAborts \/ Hold

(* State constraints for a configuration that follows several reverts of the
   agent in a row: only the agent's own work, and few builds. *)
AgentWorkOnly == person = "none"
FewBuilds == produced <= 4

(* Section: Allowed executions and fairness

Next chooses an enabled transition. Spec permits stuttering and requires
weak fairness for the listed progress actions; this does not impose deadlines.
*)
Next == Edit \/ OutsideEdit \/ HeadMoves \/ QuietElapses \/ Tick \/ RunEnds \/ TimesOut
        \/ ReadResults \/ Flush \/ TurnStarts \/ TurnCompletes
        \/ Observe \/ PersonCommits \/ Settle \/ TellRevert \/ TellHold

Spec ==
    /\ Init /\ [][Next]_vars
    /\ WF_vars(QuietElapses) /\ WF_vars(Tick) /\ WF_vars(TimesOut)
    /\ WF_vars(ReadResults) /\ WF_vars(Flush)
    /\ WF_vars(WokenTurnStarts) /\ WF_vars(TurnCompletes) /\ WF_vars(TellRevert)
    /\ WF_vars(TellHold) /\ WF_vars(Settle)

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
RegressionsReachAgent ==
    <>[](Regressions \subseteq knows \/ TimedOut \in knows \/ WaitsForTurn \/ held)
OutsideChangesNeverWake ==
    [][told' # told /\ told'.kind = "failed" /\ outbox'.waking
        => edited \/ TimedOut \in outbox'.failures]_vars

(* Section: TCR properties

A revert never discards work of a person that was there at the start or that
a tool that does not edit has seen; nothing in Revert itself checks this, it
follows from TCR being unavailable while such work is there. Work of a person
that no such tool has seen, because it came just before the agent's edit,
cannot be told from the agent's and a revert discards it: this is a limit, not
a property. A commit settles only a green result of the latest edit and moves
the restore point to it, and a revert only a result with a new failure of the
latest edit; each clears the edit's due settlement. Neither acts on an
overtaken result, on a failing result of a check that had no earlier result or
that timed out, or while TCR is unavailable. A held edit changes
nothing and a failed commit changes nothing, so no work is lost. A commit and
a revert are each all or nothing: the restore point, the person's work and the
workspace are either all as the step makes them or all as they were, never half
of each, which a failed or refused commit and an aborted revert leave as they
were. A pull needs
a clean tree and the restore point is never older than the baseline. Every
revert and every hold adds its notice to the queue and keeps the notices that
are waiting, no notice is dropped before it is delivered, a delivered notice is
the queue that was waiting, and every edit is settled unless TCR becomes
unavailable or the revert needs a version beyond the bound.
*)
SeenWorkPausesTcr == person = "seen" => tcr # "active"
RestorePointIsNotOlderThanBaseline == ck >= based
NoticesNameNewFailures ==
    \A i \in 1..Len(notices) : notices[i] # {} /\ TimedOut \notin notices[i]
HoldsNameTheFailures == \A i \in 1..Len(holds) : holds[i] # {}
RevertNoticeNamesNewFailures ==
    [][Revert => \A name \in Names :
         name \in notices'[Len(notices')] <=> (name \in report.failures /\ name \notin baseline.failures)]_vars
HeadOnlyGrows == [][head' >= head]_vars
RevertNeverDiscardsSeenWork == [][Revert => person # "seen"]_vars
RevertRestoresCheckpointContent == [][Revert => truth'[head'] = truth[ck]]_vars
RevertFollowsNewFailure == [][Revert => NewFailure(report.failures, baseline.failures)]_vars
CheckpointFollowsGreenResult ==
    [][Checkpoint => report.known /\ ~Guard /\ TimedOut \notin report.failures]_vars
CheckpointAdvancesRestorePoint == [][Checkpoint => ck' = head]_vars
SettlingClearsDue == [][(Checkpoint \/ Revert \/ Hold) => ~settleDue']_vars
OvertakenResultsNeverSettle ==
    [][(Checkpoint \/ CheckpointFails \/ Revert \/ RevertAborts \/ Hold) => report.at = head]_vars
UnprovenResultsNeverCommitOrRevert ==
    [][(Checkpoint \/ CheckpointFails \/ Revert) => ~Unproven]_vars
HoldFollowsAnUnprovenResult ==
    [][Hold => (firstResult \/ held \/ TimedOut \in report.failures) /\ report.failures # {}]_vars
ATimedOutCheckOnlyHolds ==
    [][(Checkpoint \/ CheckpointFails \/ Revert \/ RevertAborts) => TimedOut \notin report.failures]_vars
HeldEditChangesNothing ==
    [][Hold => head' = head /\ ck' = ck /\ person' = person /\ tcr' = tcr
               /\ held' /\ heldAt' = head]_vars
HeldEditsAreCommittedByAPass ==
    [][(held /\ ~held') => (Checkpoint \/ CheckpointFails \/ HeadMoves)]_vars
APullClearsTheHold == [][HeadMoves => ~held' /\ heldAt' = NoHold]_vars
AResultThatPassesClearsTheHold == [][(held /\ (Checkpoint \/ CheckpointFails)) => ~held']_vars
HeldEditsAreNeverReverted == [][Revert => ~held]_vars
AHeldFailureIsOnlyHeldAgain ==
    [][(Judged /\ held /\ report.failures # {})
         => ~(Checkpoint \/ CheckpointFails \/ Revert \/ RevertAborts)]_vars
AHoldRemembersItsTree == heldAt # NoHold => held
HeldEditSurvivesATurnStart ==
    [][(TurnStarts /\ tcr # "off" /\ HeldTreeUnchanged) => tcr' = "active"]_vars
ChangedTreeStopsTcrAtTheTurnStart ==
    [][(TurnStarts /\ tcr # "off" /\ ~Clean /\ ~(held /\ heldAt = head /\ person = "none"))
         => tcr' # "active"]_vars
HeldEditDoesNotSurviveAChangedTree ==
    [][(TurnStarts /\ tcr # "off" /\ ~Clean /\ held /\ heldAt # head) => tcr' # "active"]_vars
CheckpointAndRevertLeaveACleanTree ==
    [][(Checkpoint \/ Revert) => ck' = head' /\ person' = "none"]_vars
RevertNeverLosesUnsavedWork ==
    [][RevertAborts => /\ head' = head /\ ck' = ck /\ person' = person
                       /\ truth' = truth /\ saved' = saved /\ settleDue' = settleDue
                       /\ tcr' = "unavailable"]_vars
CheckpointIsAllOrNothing ==
    [][(Checkpoint \/ CheckpointFails) =>
        \/ (ck' = head /\ person' = "none" /\ head' = head /\ truth' = truth)
        \/ (ck' = ck /\ person' = person /\ head' = head /\ truth' = truth)]_vars
RevertIsAllOrNothing ==
    [][(Revert \/ RevertAborts) =>
        \/ (ck' = head' /\ person' = "none" /\ truth'[head'] = truth[ck])
        \/ (ck' = ck /\ person' = person /\ head' = head /\ truth' = truth)]_vars
SavedRevertKeepsTheDiscardedWork ==
    [][Revert => saved' = IF SaveReverted THEN Append(saved, truth[head]) ELSE saved]_vars
SavingChangesNoTree == [][(Revert /\ SaveReverted) => truth'[head'] = truth[ck]]_vars
UnavailableTcrChangesNothing ==
    [][tcr # "active" => ~(Checkpoint \/ CheckpointFails \/ Revert \/ RevertAborts \/ Hold)]_vars
FailedCommitLosesNothing ==
    [][CheckpointFails => head' = head /\ ck' = ck /\ person' = person /\ settleDue' = settleDue]_vars
RestorePointMovesWithCommits ==
    [][ck' # ck => (Checkpoint \/ Revert \/ HeadMoves \/ PersonCommits)]_vars
PullsNeedACleanTree == [][(TcrMode /\ HeadMoves) => (person = "none" /\ ck = head)]_vars
RevertKeepsEveryNotice ==
    [][Revert => notices' = Append(notices, FreshFailures)]_vars
HoldKeepsEveryHold == [][Hold => holds' = Append(holds, report.failures)]_vars
RevertNoticeTellsTheQueue ==
    [][TellRevert => noticeTold' = notices /\ noticeTold' # <<>>]_vars
HoldNoticeTellsTheQueue ==
    [][TellHold => holdTold' = holds /\ holdTold' # <<>>]_vars
RevertNoticeIsNeverDropped == [][(notices # <<>> /\ notices' = <<>>) => TellRevert]_vars
HoldNoticeIsNeverDropped == [][(holds # <<>> /\ holds' = <<>>) => TellHold]_vars
RevertNoticeReachesAgent == notices # <<>> ~> notices = <<>>
HoldNoticeReachesAgent == holds # <<>> ~> holds = <<>>
EditsAreSettled ==
    (tcr = "active" /\ settleDue)
      ~> (~settleDue \/ tcr # "active" \/ (head = MaxEdits /\ Guard))
=============================================================================
