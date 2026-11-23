---- MODULE NewImplementsOld ----
(* With TcrMode off, every behavior of Overwatch is a behavior of the system
   model as it was before TCR, fairness included: the check is the temporal
   property Old!Spec of the frozen copy, under the identity mapping. *)
EXTENDS Overwatch
Old == INSTANCE OldOverwatch
OldSpec == Old!Spec
====
