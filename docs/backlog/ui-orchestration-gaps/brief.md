# ui-orchestration-gaps

Type: feature
Priority: P1 (high)
Source: User, 2026-11-17, after the orchestrator steered two runs (`ui-code-indexer-setup`, `review-loop-limit-ui-setting`) by editing their files: "I have instructed to operate the pipeline using UI, not by modifying the files ... This should have been detected [as] a gap in the tool".

## Problem
Someone operating a run through the web UI hits decisions that the UI cannot express. Today the only way through is to edit the run's files by hand. When the orchestrator did that, nothing in the tool noticed or reported it:

1. **No stage guidance.** Answering Review findings, or telling Red tests which tests to drop after the red gate refused them, needs `docs/backlog/<slug>/manual-inputs.md`. The UI cannot write that file or show it.
2. **Waiving a Review finding is invisible.** A `## review` line saying "do not raise this again" silently drops a finding. In `ui-code-indexer-setup` it dropped the screen tests on a wrong premise. Neither the run page nor the PR lists what was waived, or by whom.
3. **Test repair claims can only be fixed in the file.** When the precheck rejects a claim (for example, the why does not cite the spec, plan, a decision, isolation or mocks), the UI shows the rejection but offers no way to correct the claim and retry.
4. **The fix-loop red gate suggests the wrong way on.** When some of the new tests already pass, recovery suggests Plan. The useful action is Resume at Red tests with guidance about which tests to drop, and that needs item 1.
5. **Hand edits go unnoticed.** A stage input (`manual-inputs.md`, `test-issues.md`, tests) changed outside the UI between two starts is committed by the next stage with no trace of who changed it or why.

## Goal
Every decision a run needs can be made in the UI, every decision made is visible on the run page and in the PR, and an edit made outside the UI is flagged rather than silently used.

## Acceptance criteria
- The Resume and Retry dialogs have a "Guidance for <stage>" box. Its text is saved as that stage's section of `manual-inputs.md` and shown on the stage's panel. The next start uses it.
- Each open Review finding can be marked "fix" or "waive", with a required reason. Waived findings are listed on the run page and in the PR body under "Waived findings", and Review is told not to raise them again.
- A rejected Test repair claim can be edited and resubmitted from the run page. The precheck's reason is shown next to the claim.
- When the fix-loop red gate finds already-passing tests, recovery offers "Resume at Red tests" with the passing test names prefilled as guidance to drop them.
- When a start finds `manual-inputs.md` or `test-issues.md` changed since the last UI action without the UI writing it, the run page shows an "edited outside the UI" notice naming the file. The start records it in `decisions.md`.
- Tests go through the server API: guidance saved and passed to the stage prompt, a waiver listed and passed to Review, a claim edited and rechecked, and an outside edit detected.

## Notes
- The orchestrator's rule, now in its memory, is to operate runs only through the UI and to report a missing control as a tool gap instead of editing files.
- Related: `review-findings-acted-on` (Review fix loop), `stop-implement-on-test-defect`.
