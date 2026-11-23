---- MODULE TcrImplementsBase ----
(* With TcrMode on, the TCR steps change nothing the system model before TCR says, with one
   exception that TLC found and that the check states: a turn may end while a failure is held,
   which the old model, whose turn stays guarded while any failure is new, never allows. Every
   other step of Overwatch is a step of the old model, or leaves its variables as they are.
   Checkpoint, CheckpointFails, Hold, Observe, PersonCommits, RevertAborts and the two Tell steps
   change only variables the old model lacks. A Revert is, for the old model, a change of the
   workspace by another process, OutsideEdit. It also writes the content of the restore point
   into the version it creates, while the old model keeps its results of every version fixed from
   its first state. The prophecy variable proph guesses, in the first state, the result that each
   version has when it becomes the workspace; ProphecyHolds keeps only the behaviors whose guess
   is right, and every behavior of Overwatch has one such guess. The old model's results are
   proph, so a Revert does not change them.
   What is checked is the safety of the old model with the extra step HeldCompletes. Fairness
   is not: under the old model's weak fairness of TurnCompletes a turn that ends only because of a
   hold would be a step the old model does not fairly take, so the progress of TCR is checked
   by its own properties in OverwatchTcr.cfg and not through the old model. *)
EXTENDS Overwatch
VARIABLE proph
ProphVars == <<vars, proph>>
ProphecyHolds == truth[head] = proph[head]
ProphInit == Init /\ proph \in [Versions -> Results] /\ ProphecyHolds
ProphStep(action) == action /\ UNCHANGED proph /\ ProphecyHolds'
ProphNext == ProphStep(Next)
ProphSpec ==
    /\ ProphInit /\ [][ProphNext]_ProphVars
    /\ WF_ProphVars(ProphStep(QuietElapses)) /\ WF_ProphVars(ProphStep(Tick)) /\ WF_ProphVars(ProphStep(TimesOut))
    /\ WF_ProphVars(ProphStep(ReadResults)) /\ WF_ProphVars(ProphStep(Flush))
    /\ WF_ProphVars(ProphStep(WokenTurnStarts)) /\ WF_ProphVars(ProphStep(TurnCompletes))
    /\ WF_ProphVars(ProphStep(TellRevert)) /\ WF_ProphVars(ProphStep(TellHold)) /\ WF_ProphVars(ProphStep(Settle))
Old == INSTANCE OldOverwatch WITH truth <- proph
HeldCompletes ==
    /\ turn = "running" /\ Guard /\ held
    /\ turn' = "idle" /\ flush' = TRUE
    /\ UNCHANGED <<proph, head, based, busy, from, quiet, installed, produced, consumed, pending, report,
                   baseline, wasFailing, outbox, told, toldThisTurn, promptQueued, knows, elapsed, edited,
                   touched, own>>
OldSafety == Old!Init /\ [][Old!Next \/ HeldCompletes]_Old!vars
====
