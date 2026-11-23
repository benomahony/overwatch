---- MODULE Probes ----
(* Each probe says that something never happens. TLC reports a violation when it can, and the
   trace is the proof that it can: the properties of TCR are not vacuous if the scenarios they
   guard are reachable. NoRevertOfUnseenWork is the documented limit; it needs three versions. *)
EXTENDS Overwatch
NeverReverts == [][~Revert]_vars
NeverCheckpoints == [][~Checkpoint]_vars
NeverCheckpointFails == [][~CheckpointFails]_vars
NeverCheckpointsAfterARevert == [][~(Checkpoint /\ saved # <<>>)]_vars
NeverRevertAborts == [][~RevertAborts]_vars
NeverAbortsACommitWithWorkPending == [][~(CheckpointFails /\ ck # head)]_vars
NeverHolds == [][~Hold]_vars
NeverObserves == [][~Observe]_vars
NeverPersonCommits == [][~PersonCommits]_vars
NeverTellsRevert == [][~TellRevert]_vars
NeverTellsHold == [][~TellHold]_vars
NeverPulls == [][~HeadMoves]_vars
NeverHoldsATimeout == [][~(Hold /\ TimedOut \in report.failures)]_vars
NeverPullsWhileHeld == [][~(HeadMoves /\ held)]_vars
NeverUnavailable == [](tcr = "active")
NeverResumes == [](tcr = "unavailable" => [](tcr # "active"))
NeverDirtyStart == [](person # "seen")
NoRevertOfUnseenWork == [][~(Revert /\ person = "unseen")]_vars
====
