---------------------------- MODULE Overwatch ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS SlotCount, TaskIds, ProcIds, MaxSessions, GiveUp, HasBaseline, CanDisable, LateAppendIsRead

Slots == 1..SlotCount
None == "none"
Verdicts == {"pass", "fail"}
NoPrompt == [slot |-> 0, msg |-> None]
Free == [pc |-> "free", slot |-> 0, epoch |-> 0, proc |-> 0, quick |-> FALSE]
ProcFree == [state |-> "free", kind |-> None, slot |-> 0, epoch |-> 0, quick |-> FALSE, verdict |-> None, pending |-> None]
Min(a, b) == IF a < b THEN a ELSE b

VARIABLES
    live, epoch, enabled, everDisabled,
    turn, isTurnRunning, known,
    inbox, prompt, isPromptQueued, toldAfterEnd,
    latest, wasFailing, toldWhileDisabled,
    isChecking, isRecheckDue, isWatching, quickExits, retryPending, kill,
    task, proc

hostVars == <<live, epoch, enabled, everDisabled>>
agentVars == <<turn, isTurnRunning, known>>
tellVars == <<inbox, prompt, isPromptQueued, toldAfterEnd>>
reportVars == <<latest, wasFailing, toldWhileDisabled>>
slotVars == <<isChecking, isRecheckDue, isWatching, quickExits, retryPending, kill>>
vars == <<hostVars, agentVars, tellVars, reportVars, slotVars, task, proc>>

FreeTasks == {t \in TaskIds : task[t].pc = "free"}
FreeProcs == {p \in ProcIds : proc[p].state = "free"}
LookFor(s, ep) == [Free EXCEPT !.pc = "lookFor", !.slot = s, !.epoch = ep]
Spawn(s, kind) == [ProcFree EXCEPT !.state = "alive", !.kind = kind, !.slot = s, !.epoch = epoch]

Tell(s, msg, isWaking) ==
    /\ toldAfterEnd' = (toldAfterEnd \/ ~live)
    /\ IF ~live
         THEN UNCHANGED <<inbox, prompt, isPromptQueued>>
       ELSE IF isTurnRunning
         THEN /\ inbox' = IF msg \in Verdicts THEN [inbox EXCEPT ![s] = msg] ELSE inbox
              /\ UNCHANGED <<prompt, isPromptQueued>>
       ELSE IF isWaking /\ ~isPromptQueued
         THEN /\ isPromptQueued' = TRUE
              /\ prompt' = [slot |-> s, msg |-> msg]
              /\ UNCHANGED inbox
       ELSE UNCHANGED <<inbox, prompt, isPromptQueued>>

Deliver(s, v) ==
    /\ latest' = [latest EXCEPT ![s] = v]
    /\ wasFailing' = [wasFailing EXCEPT ![s] = (v = "fail")]
    /\ toldWhileDisabled' = (toldWhileDisabled \/ ~enabled)
    /\ IF v = "fail" \/ wasFailing[s] THEN Tell(s, v, v = "fail") ELSE UNCHANGED tellVars

EnsureAll(alive) ==
    LET go(s) == alive /\ ~isWatching[s] /\ ~isChecking[s]
        S == {s \in Slots : go(s)}
    IN /\ isRecheckDue' = [s \in Slots |-> IF ~alive \/ isWatching[s] THEN isRecheckDue[s] ELSE ~go(s)]
       /\ isChecking' = [s \in Slots |-> isChecking[s] \/ go(s)]
       /\ \E f \in [S -> FreeTasks] :
            /\ \A a, b \in S : f[a] = f[b] => a = b
            /\ task' = [t \in TaskIds |-> IF \E s \in S : f[s] = t
                                           THEN LookFor(CHOOSE s \in S : f[s] = t, epoch)
                                           ELSE task[t]]

EnsureFrom(t, s, isWatchingNow) ==
    LET go == live /\ ~isWatchingNow /\ ~isChecking[s]
    IN /\ isRecheckDue' = [isRecheckDue EXCEPT ![s] = IF ~live \/ isWatchingNow THEN @ ELSE ~go]
       /\ isChecking' = [isChecking EXCEPT ![s] = @ \/ go]
       /\ task' = [task EXCEPT ![t] = IF go THEN LookFor(s, epoch) ELSE Free]

Init ==
    /\ live = FALSE /\ epoch = 0 /\ enabled = TRUE /\ everDisabled = FALSE
    /\ turn = "idle" /\ isTurnRunning = FALSE /\ known = [s \in Slots |-> None]
    /\ inbox = [s \in Slots |-> None] /\ prompt = NoPrompt
    /\ isPromptQueued = FALSE /\ toldAfterEnd = FALSE
    /\ latest = [s \in Slots |-> None] /\ wasFailing = [s \in Slots |-> FALSE]
    /\ toldWhileDisabled = FALSE
    /\ isChecking = [s \in Slots |-> FALSE] /\ isRecheckDue = [s \in Slots |-> FALSE]
    /\ isWatching = [s \in Slots |-> FALSE] /\ quickExits = [s \in Slots |-> 0]
    /\ retryPending = [s \in Slots |-> FALSE] /\ kill = [s \in Slots |-> 0]
    /\ task = [t \in TaskIds |-> Free] /\ proc = [p \in ProcIds |-> ProcFree]

SessionStart ==
    /\ ~live
    /\ live' = TRUE
    /\ EnsureAll(TRUE)
    /\ UNCHANGED <<epoch, enabled, everDisabled, agentVars, tellVars, reportVars>>
    /\ UNCHANGED <<isWatching, quickExits, retryPending, kill, proc>>

SessionEnd ==
    /\ live /\ epoch + 1 < MaxSessions
    /\ live' = FALSE
    /\ epoch' = epoch + 1
    /\ isWatching' = [s \in Slots |-> FALSE]
    /\ proc' = [p \in ProcIds |->
                 IF proc[p].state = "alive" /\ \E s \in Slots : kill[s] = p
                 THEN [proc[p] EXCEPT !.state = "dead", !.verdict = "fail"]
                 ELSE proc[p]]
    /\ turn' = "idle"
    /\ known' = [s \in Slots |-> None]
    /\ inbox' = [s \in Slots |-> None]
    /\ prompt' = NoPrompt
    /\ latest' = [s \in Slots |-> None]
    /\ UNCHANGED <<enabled, everDisabled, isTurnRunning, isPromptQueued, toldAfterEnd>>
    /\ UNCHANGED <<wasFailing, toldWhileDisabled, isChecking, isRecheckDue, quickExits, retryPending, kill, task>>

TurnStart ==
    /\ live /\ turn = "idle"
    /\ turn' = "running"
    /\ isTurnRunning' = TRUE
    /\ isPromptQueued' = FALSE
    /\ known' = IF prompt.msg \in Verdicts THEN [known EXCEPT ![prompt.slot] = prompt.msg] ELSE known
    /\ prompt' = NoPrompt
    /\ EnsureAll(TRUE)
    /\ UNCHANGED <<hostVars, inbox, toldAfterEnd, reportVars>>
    /\ UNCHANGED <<isWatching, quickExits, retryPending, kill, proc>>

AgentStep ==
    /\ turn = "running" \/ (LateAppendIsRead /\ turn = "finishing")
    /\ known' = [s \in Slots |-> IF inbox[s] = None THEN known[s] ELSE inbox[s]]
    /\ inbox' = [s \in Slots |-> None]
    /\ UNCHANGED <<hostVars, turn, isTurnRunning, prompt, isPromptQueued, toldAfterEnd>>
    /\ UNCHANGED <<reportVars, slotVars, task, proc>>

AgentFinish ==
    /\ turn = "running"
    /\ turn' = "finishing"
    /\ UNCHANGED <<hostVars, isTurnRunning, known, tellVars, reportVars, slotVars, task, proc>>

TurnComplete ==
    /\ turn = "finishing"
    /\ LateAppendIsRead => inbox = [s \in Slots |-> None]
    /\ turn' = "idle"
    /\ isTurnRunning' = FALSE
    /\ EnsureAll(TRUE)
    /\ UNCHANGED <<hostVars, known, tellVars, reportVars>>
    /\ UNCHANGED <<isWatching, quickExits, retryPending, kill, proc>>

ToggleEnabled ==
    /\ CanDisable
    /\ enabled' = ~enabled
    /\ everDisabled' = (everDisabled \/ enabled)
    /\ UNCHANGED <<live, epoch, agentVars, tellVars, reportVars, slotVars, task, proc>>

TimePasses(s) ==
    /\ retryPending[s]
    /\ retryPending' = [retryPending EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars, task, proc>>
    /\ UNCHANGED <<isChecking, isRecheckDue, isWatching, quickExits, kill>>

LookForResolves(t) ==
    LET s == task[t].slot
        found == enabled /\ ~retryPending[s]
    IN /\ task[t].pc = "lookFor"
       /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars, quickExits>>
       /\ IF isWatching[s] \/ epoch # task[t].epoch
            THEN /\ isChecking' = [isChecking EXCEPT ![s] = FALSE]
                 /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<isRecheckDue, isWatching, retryPending, kill, proc>>
          ELSE IF ~found
            THEN /\ IF isRecheckDue[s] /\ live
                      THEN /\ isRecheckDue' = [isRecheckDue EXCEPT ![s] = FALSE]
                           /\ task' = [task EXCEPT ![t] = LookFor(s, epoch)]
                           /\ UNCHANGED isChecking
                      ELSE /\ isChecking' = [isChecking EXCEPT ![s] = FALSE]
                           /\ task' = [task EXCEPT ![t] = Free]
                           /\ UNCHANGED isRecheckDue
                 /\ UNCHANGED <<isWatching, retryPending, kill, proc>>
          ELSE /\ isChecking' = [isChecking EXCEPT ![s] = FALSE]
               /\ isWatching' = [isWatching EXCEPT ![s] = TRUE]
               /\ retryPending' = [retryPending EXCEPT ![s] = FALSE]
               /\ UNCHANGED isRecheckDue
               /\ IF HasBaseline
                    THEN \E p \in FreeProcs :
                           /\ proc' = [proc EXCEPT ![p] = Spawn(s, "baseline")]
                           /\ kill' = [kill EXCEPT ![s] = p]
                           /\ task' = [task EXCEPT ![t].pc = "baseline", ![t].proc = p]
                    ELSE /\ task' = [task EXCEPT ![t].pc = "clock"]
                         /\ UNCHANGED <<kill, proc>>

BaselineEnds(t) ==
    LET s == task[t].slot
        p == task[t].proc
    IN /\ task[t].pc = "baseline"
       /\ proc[p].state = "dead"
       /\ kill' = [kill EXCEPT ![s] = 0]
       /\ proc' = [proc EXCEPT ![p] = ProcFree]
       /\ IF isWatching[s]
            THEN /\ Deliver(s, proc[p].verdict)
                 /\ task' = [task EXCEPT ![t].pc = "clock", ![t].proc = 0]
            ELSE /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<tellVars, reportVars>>
       /\ UNCHANGED <<hostVars, agentVars, isChecking, isRecheckDue, isWatching, quickExits, retryPending>>

ClockResolves(t) ==
    LET s == task[t].slot
    IN /\ task[t].pc = "clock"
       /\ IF isWatching[s]
            THEN \E p \in FreeProcs :
                   /\ proc' = [proc EXCEPT ![p] = Spawn(s, "watch")]
                   /\ kill' = [kill EXCEPT ![s] = p]
                   /\ task' = [task EXCEPT ![t].pc = "watch", ![t].proc = p]
            ELSE /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<kill, proc>>
       /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars>>
       /\ UNCHANGED <<isChecking, isRecheckDue, isWatching, quickExits, retryPending>>

WatcherEnds(t) ==
    LET s == task[t].slot
        p == task[t].proc
    IN /\ task[t].pc = "watch"
       /\ proc[p].state = "dead"
       /\ kill' = [kill EXCEPT ![s] = 0]
       /\ proc' = [proc EXCEPT ![p] = ProcFree]
       /\ IF isWatching[s]
            THEN /\ task' = [task EXCEPT ![t].pc = "ended", ![t].proc = 0, ![t].quick = proc[p].quick]
                 /\ IF proc[p].pending # None
                      THEN Deliver(s, proc[p].pending)
                      ELSE UNCHANGED <<tellVars, reportVars>>
            ELSE /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<tellVars, reportVars>>
       /\ UNCHANGED <<hostVars, agentVars, isChecking, isRecheckDue, isWatching, quickExits, retryPending>>

Restart(t) ==
    LET s == task[t].slot
        q == IF task[t].quick THEN Min(quickExits[s] + 1, GiveUp + 1) ELSE 0
    IN /\ task[t].pc = "ended"
       /\ UNCHANGED <<hostVars, agentVars, reportVars, kill, proc>>
       /\ IF epoch # task[t].epoch
            THEN /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<tellVars, isChecking, isRecheckDue, isWatching, quickExits, retryPending>>
            ELSE /\ quickExits' = [quickExits EXCEPT ![s] = q]
                 /\ isWatching' = [isWatching EXCEPT ![s] = FALSE]
                 /\ IF q >= GiveUp
                      THEN /\ retryPending' = [retryPending EXCEPT ![s] = TRUE]
                           /\ task' = [task EXCEPT ![t] = Free]
                           /\ IF q = GiveUp THEN Tell(s, "gaveup", TRUE) ELSE UNCHANGED tellVars
                           /\ UNCHANGED <<isChecking, isRecheckDue>>
                    ELSE IF task[t].quick
                      THEN /\ retryPending' = [retryPending EXCEPT ![s] = TRUE]
                           /\ task' = [task EXCEPT ![t].pc = "timer"]
                           /\ UNCHANGED <<tellVars, isChecking, isRecheckDue>>
                    ELSE /\ retryPending' = [retryPending EXCEPT ![s] = FALSE]
                         /\ EnsureFrom(t, s, FALSE)
                         /\ UNCHANGED tellVars

TimerFires(t) ==
    LET s == task[t].slot
    IN /\ task[t].pc = "timer"
       /\ retryPending' = [retryPending EXCEPT ![s] = FALSE]
       /\ IF epoch = task[t].epoch
            THEN EnsureFrom(t, s, isWatching[s])
            ELSE /\ task' = [task EXCEPT ![t] = Free]
                 /\ UNCHANGED <<isChecking, isRecheckDue>>
       /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars, isWatching, quickExits, kill, proc>>

ProcPrints(p) ==
    /\ proc[p].state = "alive"
    /\ proc[p].kind = "watch"
    /\ \E v \in Verdicts : proc' = [proc EXCEPT ![p].pending = v]
    /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars, slotVars, task>>

FlushFires(p) ==
    /\ proc[p].state # "free"
    /\ proc[p].pending # None
    /\ Deliver(proc[p].slot, proc[p].pending)
    /\ proc' = [proc EXCEPT ![p].pending = None]
    /\ UNCHANGED <<hostVars, agentVars, slotVars, task>>

ProcExits(p) ==
    /\ proc[p].state = "alive"
    /\ \E quick \in BOOLEAN, v \in Verdicts :
         proc' = [proc EXCEPT ![p].state = "dead", ![p].quick = quick, ![p].verdict = v]
    /\ UNCHANGED <<hostVars, agentVars, tellVars, reportVars, slotVars, task>>

Next ==
    \/ SessionStart \/ SessionEnd
    \/ TurnStart \/ AgentStep \/ AgentFinish \/ TurnComplete
    \/ ToggleEnabled
    \/ \E s \in Slots : TimePasses(s)
    \/ \E t \in TaskIds :
         \/ LookForResolves(t) \/ BaselineEnds(t) \/ ClockResolves(t)
         \/ WatcherEnds(t) \/ Restart(t) \/ TimerFires(t)
    \/ \E p \in ProcIds : ProcPrints(p) \/ FlushFires(p) \/ ProcExits(p)

Spec == Init /\ [][Next]_vars

OneWatcherPerSlot ==
    \A s \in Slots : Cardinality({p \in ProcIds : proc[p].state = "alive" /\ proc[p].slot = s}) <= 1

KillReachesEveryProcess ==
    \A p \in ProcIds : proc[p].state = "alive" => kill[proc[p].slot] = p

NoOrphanAfterSessionEnd ==
    \A p \in ProcIds : proc[p].state = "alive" => proc[p].epoch = epoch

NoSilentRed ==
    (live /\ turn = "idle" /\ prompt = NoPrompt) =>
        \A s \in Slots : latest[s] = "fail" => known[s] = "fail"

NoTellAfterSessionEnd == ~toldAfterEnd

DisabledMeansQuiet == ~toldWhileDisabled

NoStalledSlot ==
    (live /\ enabled /\ ~everDisabled /\ turn = "idle" /\ prompt = NoPrompt) =>
        \A s \in Slots :
            \/ isWatching[s]
            \/ quickExits[s] >= GiveUp
            \/ \E t \in TaskIds : task[t].pc # "free" /\ task[t].slot = s /\ task[t].epoch = epoch
=============================================================================
