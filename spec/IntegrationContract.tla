---------------------- MODULE IntegrationContract ----------------------
(* Section: Imports

Shared operators used by this module are imported below.
*)
EXTENDS Naturals, FiniteSets, FailurePolicy

(* Section: Integration boundary

This layer receives completed per-check snapshots from Overwatch.
It specifies requests, responses, delivery channels, and session lifecycle
for every host. Both layers use the same FailurePolicy definitions.
*)
CONSTANTS Hosts, Checks, Names, MaxRequests, MaxChanges, MaxSessions, MaxNotices

AllHosts == {"claude", "codex", "opencode1", "opencode2", "pi", "neovim"}
ASSUME Hosts \subseteq AllHosts /\ Hosts # {}

(* These are host capabilities, not advisory/strict policy modes. A warning
   cannot be counted as a denied completion, and an editor has no agent gate. *)
(* Section: Host capabilities

The host determines whether protected requests wait for a running check,
how guarded completion is handled, and which delivery channels exist.
A host notices another process's change when it can tell it from the
session's own: Claude Code reads each watcher result against the session's
edits, Codex and OpenCode 2 see a change first at a hook that follows no
edit of the session's, and an editor treats every save alike. Pi and
OpenCode 1 check only after the session's own edits and at settlement, so
they read every result as the session's.
These are integration capabilities, not user-selectable enforcement modes.
*)
Capabilities(h) ==
    [agent |-> h # "neovim",
     waitsForCheck |-> h \in {"codex", "opencode1", "opencode2", "pi"},
     completion |-> CASE h \in {"claude", "codex"} -> "block"
                      [] h = "opencode1" -> "warn"
                      [] h = "opencode2" -> "queue"
                      [] h = "pi" -> "continue"
                      [] OTHER -> "none",
     delivery |-> CASE h = "claude" -> "turn"
                    [] h = "opencode2" -> "context"
                    [] h = "neovim" -> "quickfix"
                    [] OTHER -> "event",
     idleWake |-> h \in {"claude", "opencode2"},
     status |-> h \in {"claude", "pi", "neovim"},
     noticesOutside |-> h \in {"claude", "codex", "opencode2", "neovim"},
     tcr |-> h \in {"codex", "opencode1", "opencode2", "pi"}]

Kinds == {"inspect", "repair", "publish", "complete"}
Empty == [c \in Checks |-> {}]
Snapshots == [Checks -> SUBSET Names]
NoReply == [ready |-> FALSE, decision |-> "none"]

(* Section: State shape

Request and reply are separate so that a check can finish or a session can
close between them. Report visibility, deferred context, corrections, and
idle wakeups are separate observations.
*)
VARIABLES host, active, busy, reports, baseline, inherited, selected,
          request, reply, requests, changes, session,
          visible, contextPending, contextSent, correctionQueued,
          contexts, warnings, corrections, inTurn, wakes, work,
          correctionPending, correctionTurn, outside, outsides,
          noticePending, noticesRaised, noticesTold

vars == <<host, active, busy, reports, baseline, inherited, selected,
          request, reply, requests, changes, session, visible,
          contextPending, contextSent, correctionQueued, contexts,
          warnings, corrections, inTurn, wakes, work,
          correctionPending, correctionTurn, outside, outsides,
          noticePending, noticesRaised, noticesTold>>
noticeVars == <<noticePending, noticesRaised, noticesTold>>

(* Section: Guard selection and inherited policy

An empty selection means all checks. FailureGuards decides whether each
selected check guards publication; Notify identifies new failures for delivery.
*)
Guarded(scope) ==
    {c \in scope : FailureGuards(reports[c], baseline[c], inherited)}
Guard == Capabilities(host).agent /\ Guarded(Checks) # {}
Notify == Capabilities(host).agent /\
          (\E c \in Checks : FailureGuards(reports[c], baseline[c], "allow"))
SelectedChecks == IF selected = {} THEN Checks ELSE selected

(* Section: State domains

Counters and snapshots are bounded for TLC exploration. These bounds
do not assert a runtime limit on requests or sessions.
*)
TypeOK ==
    /\ host \in Hosts /\ active \in BOOLEAN /\ busy \in BOOLEAN
    /\ work \in 0..((MaxSessions + 1) * MaxRequests)
    /\ inTurn \in BOOLEAN
    /\ wakes \in 0..(MaxChanges + MaxSessions + 1 + (MaxSessions + 1) * MaxRequests)
    /\ reports \in Snapshots /\ baseline \in Snapshots
    /\ inherited \in {"allow", "block"} /\ selected \subseteq Checks
    /\ request \in Kinds \cup {"none"}
    /\ reply \in [ready : BOOLEAN,
                   decision : {"none", "allow", "deny", "block", "warn", "queue", "continue", "cancelled"}]
    /\ requests \in 0..MaxRequests /\ changes \in 0..MaxChanges /\ session \in 0..MaxSessions
    /\ visible \in [known : BOOLEAN, failures : Snapshots]
    /\ contextPending \in BOOLEAN /\ contextSent \in BOOLEAN /\ correctionQueued \in BOOLEAN
    /\ contexts \in 0..(MaxChanges + MaxSessions + 1)
    /\ warnings \in 0..((MaxSessions + 1) * MaxRequests)
    /\ corrections \in 0..((MaxSessions + 1) * MaxRequests)
    /\ correctionPending \in BOOLEAN /\ correctionTurn \in BOOLEAN /\ outside \in BOOLEAN
    /\ outsides \in 0..MaxChanges
    /\ noticePending \in BOOLEAN
    /\ noticesRaised \in 0..MaxNotices /\ noticesTold \in 0..MaxNotices

(* Section: Initial state

A host starts active with arbitrary reports, baseline, policy, and check state.
No reply, visible report, deferred context, or correction has been produced.
*)
Init ==
    /\ host \in Hosts /\ active = TRUE /\ busy \in BOOLEAN
    /\ reports \in Snapshots /\ baseline \in Snapshots
    /\ inherited \in {"allow", "block"} /\ selected \in SUBSET Checks
    /\ request = "none" /\ reply = NoReply
    /\ requests = 0 /\ changes = 0 /\ session = 0
    /\ visible = [known |-> FALSE, failures |-> Empty]
    /\ contextPending = FALSE /\ contextSent = FALSE /\ correctionQueued = FALSE
    /\ contexts = 0 /\ warnings = 0 /\ corrections = 0 /\ wakes = 0 /\ work = 0 /\ inTurn \in BOOLEAN
    /\ correctionPending = FALSE /\ correctionTurn = FALSE /\ outside = FALSE /\ outsides = 0
    /\ noticePending = FALSE /\ noticesRaised = 0 /\ noticesTold = 0

(* Section: Requests and completion decisions

Inspection and repair remain answerable during checks. Protected requests
follow the host waiting capability and consult the selected reports.
Respond records the decision and accounts separately for warnings,
corrections, and wakeups; Acknowledge releases the request slot.
*)
Request(k) ==
    /\ active /\ request = "none" /\ requests < MaxRequests
    /\ request' = k /\ reply' = NoReply /\ requests' = requests + 1
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   changes, session, visible, contextPending, contextSent,
                   correctionQueued, contexts, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

CanRespond ==
    active /\ request # "none" /\ ~reply.ready /\
    (request \in {"inspect", "repair"} \/ ~Capabilities(host).agent \/
     ~Capabilities(host).waitsForCheck \/ ~busy)

Decision ==
    CASE request \in {"inspect", "repair"} -> "allow"
      [] request = "publish" ->
           IF Capabilities(host).agent /\ Guarded(SelectedChecks) # {}
           THEN "deny" ELSE "allow"
      [] request = "complete" -> IF Guard THEN Capabilities(host).completion ELSE "allow"

QueuesCorrection == Decision = "queue" \/ (host = "claude" /\ Decision = "block")
EndsTurn == request = "complete" /\ (Decision \in {"allow", "warn", "queue"} \/ host = "claude")

Respond ==
    /\ CanRespond
    /\ inTurn' = IF EndsTurn THEN FALSE ELSE inTurn
    /\ correctionTurn' = IF EndsTurn THEN FALSE ELSE correctionTurn
    /\ correctionPending' = (correctionPending \/ (QueuesCorrection /\ ~correctionQueued))
    /\ reply' = [ready |-> TRUE, decision |-> Decision]
    /\ warnings' = warnings + IF Decision = "warn" THEN 1 ELSE 0
    /\ corrections' = corrections + IF QueuesCorrection /\ ~correctionQueued THEN 1 ELSE 0
    /\ correctionQueued' = (correctionQueued \/ QueuesCorrection)
    /\ wakes' = wakes + IF QueuesCorrection /\ ~correctionQueued /\
                            (host = "opencode2" \/ ~inTurn)
                         THEN 1 ELSE 0
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, requests, changes, session, visible,
                   contextPending, contextSent, contexts, work, outside, outsides, noticeVars>>

Acknowledge ==
    /\ request # "none" /\ reply.ready
    /\ request' = "none"
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued,
                   contexts, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

(* Section: Checks and result delivery

A completed check replaces the reports. Changed findings invalidate old
delivery and correction deduplication. Report updates visibility and either
publishes event context or retains it for Deliver. Recovery clears stale context.
*)
BeginCheck ==
    /\ active /\ ~busy /\ changes < MaxChanges
    /\ busy' = TRUE
    /\ UNCHANGED <<host, active, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued,
                   contexts, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

(* The result-ordering and baseline rules are specified in Overwatch.tla.
   This layer accepts a completed result at that boundary, then constrains
   what every host must expose and which requests it may hold behind a check. *)
FinishCheck(f) ==
    /\ active /\ busy /\ changes < MaxChanges
    /\ reports' = f /\ busy' = FALSE /\ changes' = changes + 1 /\ outside' = FALSE
    /\ IF f # reports
         THEN /\ contextSent' = FALSE /\ correctionQueued' = FALSE
              /\ contextPending' = FALSE
         ELSE UNCHANGED <<contextSent, correctionQueued, contextPending>>
    /\ UNCHANGED <<host, active, baseline, inherited, selected, request,
                   reply, requests, session, visible, contexts, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, outsides, noticeVars>>

(* A check that finishes on another process's change, with no session edit
   since the last result, replaces the reports for status and guards alone:
   it neither releases correction deduplication nor counts as a change the
   session made, and Report gives it no failure context. A context still
   waiting for the old reports is dropped, as a newer result replaces it. *)
OutsideFinish(f) ==
    /\ active /\ busy /\ outsides < MaxChanges /\ Capabilities(host).noticesOutside
    /\ reports' = f /\ busy' = FALSE /\ outside' = TRUE /\ outsides' = outsides + 1
    /\ contextPending' = (contextPending /\ f = reports)
    /\ UNCHANGED <<host, active, baseline, inherited, selected, request,
                   reply, requests, changes, session, visible, contextSent,
                   correctionQueued, contexts, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, noticeVars>>

Told == Notify /\ ~outside
Report ==
    /\ active /\ ~busy
    /\ visible' = [known |-> TRUE, failures |-> reports]
    /\ contextPending' = (Told /\ ~contextSent /\ Capabilities(host).delivery \in {"turn", "context"})
    /\ contextSent' = (contextSent \/ (Told /\ Capabilities(host).delivery = "event"))
    /\ contexts' = contexts + IF Told /\ ~contextSent /\ Capabilities(host).delivery = "event" THEN 1 ELSE 0
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session,
                   correctionQueued, warnings, corrections, inTurn, wakes, work,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

Deliver ==
    /\ active /\ contextPending
    /\ wakes' = wakes + IF host = "claude" /\ ~inTurn THEN 1 ELSE 0
    /\ contextSent' = TRUE /\ contextPending' = FALSE /\ contexts' = contexts + 1
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   correctionQueued, warnings, corrections, inTurn, work,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

(* Section: Shutdown restart and new work

Stop cancels an outstanding request and clears visible and pending delivery.
Restart preserves project policy, takes reports as the new baseline, and
resets delivery state. A submitted correction runs in a turn of its own,
which on OpenCode 2 is always the next; any other turn is the person's.
Completed tool work permits a fresh correction, except in the correction's
own turn, where inspecting and repairing are its answer.
*)
Stop ==
    /\ active
    /\ inTurn' = FALSE
    /\ correctionPending' = FALSE /\ correctionTurn' = FALSE
    /\ active' = FALSE /\ busy' = FALSE /\ request' = "none"
    /\ reply' = [ready |-> TRUE, decision |-> "cancelled"]
    /\ visible' = [known |-> FALSE, failures |-> Empty]
    /\ contextPending' = FALSE /\ noticePending' = FALSE
    /\ UNCHANGED <<host, reports, baseline, inherited, selected, requests,
                   changes, session, contextSent, correctionQueued,
                   contexts, warnings, corrections, wakes, work, outside, outsides, noticesRaised, noticesTold>>

Restart ==
    /\ ~active /\ session < MaxSessions
    /\ inTurn' = FALSE
    /\ correctionPending' = FALSE /\ correctionTurn' = FALSE
    /\ active' = TRUE /\ session' = session + 1 /\ busy' = FALSE
    /\ baseline' = reports
    /\ request' = "none" /\ reply' = NoReply /\ requests' = 0
    /\ visible' = [known |-> FALSE, failures |-> Empty]
    /\ contextPending' = FALSE /\ contextSent' = FALSE /\ correctionQueued' = FALSE /\ outside' = FALSE
    /\ UNCHANGED <<host, reports, inherited, selected, changes, contexts, warnings, corrections,
                   wakes, work, outsides, noticeVars>>

StartTurn ==
    /\ active /\ ~inTurn /\ inTurn' = TRUE
    /\ ~(host = "opencode2" /\ correctionPending)
    /\ correctionTurn' = FALSE
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued, contexts,
                   warnings, corrections, wakes, work, correctionPending, outside, outsides, noticeVars>>

StartCorrectionTurn ==
    /\ active /\ ~inTurn /\ correctionPending
    /\ inTurn' = TRUE /\ correctionTurn' = TRUE /\ correctionPending' = FALSE
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued, contexts,
                   warnings, corrections, wakes, work, outside, outsides, noticeVars>>

WorkCompleted ==
    /\ active /\ work < (MaxSessions + 1) * MaxRequests
    /\ work' = work + IF correctionTurn THEN 0 ELSE 1
    /\ correctionQueued' = (correctionTurn /\ correctionQueued)
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, contexts, warnings, corrections, inTurn, wakes,
                   correctionPending, correctionTurn, outside, outsides, noticeVars>>

(* Section: Notices of a TCR revert

A host that runs TCR reverts an edit that adds a failure, and the agent has to
be told why. A host that delivers by event appends the notice to the tool
result at once. OpenCode 2 queues it for the next model request. A notice is
not a failure: a check that finds nothing guarded clears a queued failure, never
a queued notice. Each notice is delivered at most once and only a shutdown
discards one that is still queued.
*)
RevertNotice ==
    /\ active /\ Capabilities(host).tcr /\ noticesRaised < MaxNotices
    /\ noticesRaised' = noticesRaised + 1
    /\ IF Capabilities(host).delivery = "context"
         THEN noticePending' = TRUE /\ UNCHANGED noticesTold
         ELSE noticesTold' = noticesTold + 1 /\ UNCHANGED noticePending
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued, contexts, warnings,
                   corrections, inTurn, wakes, work, correctionPending, correctionTurn,
                   outside, outsides>>

DeliverNotice ==
    /\ active /\ noticePending
    /\ noticePending' = FALSE /\ noticesTold' = noticesTold + 1
    /\ UNCHANGED <<host, active, busy, reports, baseline, inherited, selected,
                   request, reply, requests, changes, session, visible,
                   contextPending, contextSent, correctionQueued, contexts, warnings,
                   corrections, inTurn, wakes, work, correctionPending, correctionTurn,
                   outside, outsides, noticesRaised>>

(* Section: Allowed executions and fairness

Spec composes check-completion fairness with fair response and report
servicing. Inspection independence is a safety property: its response
remains enabled even while a check is held.
*)
CheckCompletes == \E f \in Snapshots : FinishCheck(f) \/ OutsideFinish(f)
Next == (\E k \in Kinds : Request(k)) \/ Respond \/ Acknowledge \/ BeginCheck
        \/ CheckCompletes \/ Report \/ Deliver \/ Stop \/ Restart
        \/ RevertNotice \/ DeliverNotice
        \/ StartTurn \/ StartCorrectionTurn \/ WorkCompleted
        \/ (~active /\ session = MaxSessions /\ UNCHANGED vars)
(* Check completion fairness is the RunsEnd guarantee of the result model.
   Inspection is independently enabled; it never needs that guarantee to reply. *)
Spec == Init /\ [][Next]_vars /\ WF_vars(CheckCompletes)
        /\ WF_vars(Respond) /\ WF_vars(Report) /\ WF_vars(Deliver) /\ WF_vars(DeliverNotice)

(* Section: Safety and progress properties

Capabilities constrain completion, editors never acquire agent gates,
closed sessions stay silent, pending context stays current, and corrections
are deduplicated. Progress properties require the fairness stated in Spec.
*)
InspectionIndependentOfChecks ==
    active /\ request \in {"inspect", "repair"} /\ ~reply.ready => ENABLED Respond
InspectionAlwaysAllowed ==
    request \in {"inspect", "repair"} /\ reply.ready => reply.decision = "allow"
EditorNeverGuards ==
    host = "neovim" /\ request # "none" /\ reply.ready => reply.decision = "allow"
StoppedSessionsStaySilent == ~active => ~contextPending /\ ~visible.known /\ ~noticePending
HostsWithoutIdleWakeStayIdle == ~Capabilities(host).idleWake => wakes = 0
CorrectionRequestsAreDeduplicated == corrections <= changes + session + work + 1
PendingContextIsCurrent == contextPending => Notify
CompletionUsesHostCapability ==
    request = "complete" /\ reply.ready =>
       reply.decision \in {"allow", Capabilities(host).completion}
EditorOnlyReports ==
    host = "neovim" => contexts = 0 /\ warnings = 0 /\ corrections = 0 /\ wakes = 0
NoticesAreDeliveredOnce ==
    noticesTold + (IF noticePending THEN 1 ELSE 0) <= noticesRaised
OnlyTcrHostsRaiseNotices == noticesRaised > 0 => Capabilities(host).tcr
NoticesOutliveRecovery ==
    [][(noticePending /\ ~noticePending') => (noticesTold' = noticesTold + 1 \/ ~active')]_vars
PendingReportsEventuallyResolve == contextPending ~> ~contextPending
PendingNoticesEventuallyResolve == noticePending ~> ~noticePending
FinishedReportsBecomeVisible ==
    (active /\ ~busy) ~> (visible.known \/ ~active)
InspectionEventuallyReplies ==
    (active /\ request \in {"inspect", "repair"} /\ ~reply.ready)
      ~> (reply.ready \/ ~active)
=============================================================================
