# cost-record-last-stretch

Bug: the per-task cost record committed to git can miss the last stretch of agent work (after the final record write).
Commit the final cost to the run's PR branch at the end of the run so the record is complete.
