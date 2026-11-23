---- MODULE OldImplementsNew ----
(* The other direction: every behavior of the frozen system model is a behavior
   of Overwatch with TcrMode off, when the TCR variables hold the values that
   TCR gives them while it is off. Together the two checks show that TCR did not
   change what the model said before it. *)
EXTENDS OldOverwatch
New == INSTANCE Overwatch WITH TcrMode <- FALSE, SaveReverted <- FALSE, StartQueued <- FALSE,
         held <- FALSE, saved <- <<>>, heldAt <- MaxEdits + 1, tcr <- "off", ck <- 0,
         person <- "none",
         settleDue <- FALSE, notices <- <<>>, noticeTold <- <<>>,
         firstResult <- FALSE, holds <- <<>>, holdTold <- <<>>
NewSpec == New!Spec
====
