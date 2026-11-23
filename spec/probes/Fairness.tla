---- MODULE Fairness ----
(* Each variant of Spec leaves out the weak fairness of one action, to learn which progress claims
   need it. A claim that fails without an action's fairness depends on it, and the trace is the
   proof; a claim that still holds does not. SpecWithoutNothing is Spec. *)
EXTENDS Overwatch
Core == Init /\ [][Next]_vars
FairQuietElapses == WF_vars(QuietElapses)
FairTick == WF_vars(Tick)
FairTimesOut == WF_vars(TimesOut)
FairReadResults == WF_vars(ReadResults)
FairFlush == WF_vars(Flush)
FairWokenTurnStarts == WF_vars(WokenTurnStarts)
FairTurnCompletes == WF_vars(TurnCompletes)
FairTellRevert == WF_vars(TellRevert)
FairTellHold == WF_vars(TellHold)
FairSettle == WF_vars(Settle)
SpecWithoutNothing == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutQuietElapses == Core /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutTick == Core /\ FairQuietElapses /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutTimesOut == Core /\ FairQuietElapses /\ FairTick /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutReadResults == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutFlush == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutWokenTurnStarts == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutTurnCompletes == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTellRevert /\ FairTellHold /\ FairSettle
SpecWithoutTellRevert == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellHold /\ FairSettle
SpecWithoutTellHold == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairSettle
SpecWithoutSettle == Core /\ FairQuietElapses /\ FairTick /\ FairTimesOut /\ FairReadResults /\ FairFlush /\ FairWokenTurnStarts /\ FairTurnCompletes /\ FairTellRevert /\ FairTellHold
====
