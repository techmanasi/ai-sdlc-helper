// The CI line of a pull request: in progress, passed or failed; for a failed one the failing checks, what went wrong, and the
// button that starts Implement again with the details.
import { ciLabel } from './stages';
import { Spinner } from './ui';

// A tag is one line by default; here it wraps inside a narrow board card instead of spilling out of it.
const WRAP = { whiteSpace: 'normal', maxWidth: '100%', overflowWrap: 'anywhere' } as const;

export function PrCi({ ci, failing, summary, busy, onFix, conflicts, resolveBusy, onResolve, disabled }: {
  ci: string | null | undefined; failing: string[]; summary: string[]; busy: boolean; onFix(): void;
  /** A run is going: both buttons wait until it finishes. */
  disabled?: boolean;
  conflicts?: string | null; resolveBusy?: boolean; onResolve?(): void;
}) {
  const label = ciLabel(ci);
  const conflicting = conflicts === 'conflicting';
  if (!label && !conflicting) return null;
  return (
    <span class="col" style={{ gap: '4px', minWidth: 0, maxWidth: '100%' }}>
      {conflicting && (
        <>
          <span class="tag small mono s-failed" style={{ ...WRAP, alignSelf: 'flex-start' }}>✘ Conflicts with the base branch</span>
          {onResolve && (
            <button type="button" class="btn btn-s btn-p" style={{ alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', height: 'auto', lineHeight: 1.3 }} disabled={resolveBusy || disabled} onClick={onResolve}
              title="Fetch the base, rebase this run's branch onto it, resolve the conflicts and push with --force-with-lease">
              {resolveBusy ? <><Spinner /> Starting…</> : 'Resolve conflicts'}
            </button>
          )}
        </>
      )}
      {label && <span class={`tag small mono ${ci === 'passed' ? 's-done' : ci === 'failed' ? 's-failed' : 's-running'}`} style={{ ...WRAP, alignSelf: 'flex-start' }}>
        {ci === 'in progress' ? <Spinner /> : ci === 'passed' ? '✔' : '✘'} {label}
      </span>}
      {ci === 'failed' && (
        <>
          {failing.length > 0 && <span class="small s-failed">Failing: {failing.join(', ')}</span>}
          {summary.map(l => <span class="mono small muted" style={{ wordBreak: 'break-word' }}>{l}</span>)}
          <button type="button" class="btn btn-s btn-p" style={{ alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', height: 'auto', lineHeight: 1.3, overflowWrap: 'anywhere' }} disabled={busy || disabled} onClick={onFix}
            title="Write the CI failure into the task and run Implement again, then Review and Finalise">
            {busy ? <><Spinner /> Restarting…</> : 'Restart Implement with the CI failure'}
          </button>
        </>
      )}
    </span>
  );
}
