// The steps of each stage, in order, with a plain-language label for the run screen. ONE table: the pipeline names a
// step by its key (Status.beginStep) and the run screen shows the label, so the two cannot drift apart.

export interface StepDef { key: string; label: string }

/** Keyed by the stage name as the status file carries it ("Test repair", not "4b Test repair ..."). */
export const STEPS: Record<string, StepDef[]> = {
  Spec: [
    { key: 'answers', label: 'Recording your answers' },
    { key: 'agent', label: 'Writing the spec' },
    { key: 'check', label: 'Checking the spec was written' },
  ],
  Plan: [
    { key: 'answers', label: 'Recording your answers' },
    { key: 'agent', label: 'Writing the plan' },
    { key: 'check', label: 'Checking the plan was written' },
  ],
  'Red tests': [
    { key: 'agent', label: 'Writing the failing tests' },
    { key: 'gate', label: 'Checking the new tests fail' },
    { key: 'commit', label: 'Committing and locking the tests' },
  ],
  Implement: [
    { key: 'install', label: 'Installing dependencies' },
    { key: 'baseline', label: 'Running the tests to see where things stand' },
    { key: 'agent', label: 'Implementing' },
    { key: 'guard', label: 'Checking the tests were not changed' },
    { key: 'tests', label: 'Running the unit tests' },
    { key: 'lint', label: 'Running lint' },
    { key: 'integration', label: 'Running the integration tests' },
  ],
  'Test repair': [
    { key: 'trigger', label: 'Reading the test defects the Implement agent claimed' },
    { key: 'snapshot', label: 'Recording the current test results and re-running unclaimed failures' },
    { key: 'precheck', label: 'Checking each claimed test really fails' },
    { key: 'hash', label: 'Recording the source files so edits can be detected' },
    { key: 'agent', label: 'Repairing the claimed tests' },
    { key: 'guard', label: 'Checking the source was not touched' },
    { key: 'diff', label: 'Checking only the claimed tests changed' },
    { key: 'names', label: 'Checking no test was removed or renamed' },
    { key: 'red', label: 'Checking the repaired tests still fail without the implementation' },
    { key: 'audit', label: 'Independent audit of the repair' },
    { key: 'tests', label: 'Running the unit tests' },
    { key: 'lint', label: 'Running lint' },
    { key: 'integration', label: 'Running the integration tests' },
    { key: 'commit', label: 'Committing and locking the repaired tests' },
  ],
  Review: [
    { key: 'agent', label: 'Reviewing the code' },
    { key: 'guard', label: 'Checking the tests were not changed' },
    { key: 'tests', label: 'Running the unit tests' },
    { key: 'lint', label: 'Running lint' },
    { key: 'integration', label: 'Running the integration tests' },
  ],
  'Resolve conflicts': [
    { key: 'prepare', label: 'Saving a recovery point' },
    { key: 'rebase', label: 'Rebasing onto the base branch' },
    { key: 'resolve', label: 'Resolving the conflicting files' },
    { key: 'review', label: 'Independent review of a doubted resolution' },
    { key: 'tests', label: 'Running the unit tests' },
    { key: 'integration', label: 'Running the integration tests' },
    { key: 'push', label: 'Pushing with the lease' },
  ],
  Finalise: [
    { key: 'commit', label: 'Committing the work and preparing the pull request' },
  ],
};
