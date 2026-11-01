// Which stages a run can be resumed at, and why the others cannot: the rules the pipeline applies when it starts at
// --from <stage> (src/pipeline/stages.ts: refuseRedone, resumeAtTests), worked out before the click instead of after it.
export interface ResumeFacts {
  /** Short sha of the red-tests commit on the run's branch, '' when none. */
  redCommit: string;
  /** Whether the item has a test-issues.md (the Implement agent claimed test defects). */
  hasTestIssues: boolean;
  /** The stage the run resumes at by default ('' when it has none). */
  resumeFrom: string;
}

export interface ResumeOption {
  key: string;
  name: string;
  /** False when the pipeline would refuse or the stage cannot work yet. */
  enabled: boolean;
  /** Why it is off, or a note on an enabled one ('' for none). */
  note: string;
  suggested: boolean;
}

export const RESUME_STAGES = [
  { name: 'Spec', key: 'spec' }, { name: 'Plan', key: 'plan' }, { name: 'Red tests', key: 'red-tests' },
  { name: 'Implement', key: 'implement' }, { name: 'Test repair', key: 'test-repair' }, { name: 'Review', key: 'review' },
  { name: 'Finalise', key: 'finalise' },
];

/** The seven stages with whether a branch-keeping resume at each of them works. */
export function resumeOptions(f: ResumeFacts): ResumeOption[] {
  return RESUME_STAGES.map(({ key, name }) => {
    const suggested = key === f.resumeFrom;
    const off = (note: string): ResumeOption => ({ key, name, enabled: false, note, suggested });
    if (key === 'spec') return off('runs again from the start of the run; use Restart');
    if (key === 'plan' || key === 'red-tests') {
      return f.redCommit ? off(`refused: the red-tests commit ${f.redCommit} exists`) : { key, name, enabled: true, note: '', suggested };
    }
    if (!f.redCommit) return off('needs the red-tests commit, which does not exist yet');
    if (key === 'test-repair' && !f.hasTestIssues) return off('needs test-issues.md');
    return { key, name, enabled: true, note: suggested ? 'suggested' : '', suggested };
  });
}

/** The stage to preselect in the picker: the suggested one if it works, else the first that does. */
export function defaultPick(opts: ResumeOption[]): string {
  return (opts.find(o => o.suggested && o.enabled) || opts.find(o => o.enabled))?.key || '';
}

/** The CLI line the picker's Go button runs. */
export const resumeCommand = (slug: string, key: string): string => `start ${slug} --from ${key}`;
