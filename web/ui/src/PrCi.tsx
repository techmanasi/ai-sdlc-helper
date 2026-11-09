// The CI line of a pull request: in progress, passed or failed; for a failed one the failing checks, what went wrong, and the
// button that starts Implement again with the details.
import { ciLabel } from './stages';
import { Spinner } from './ui';

export function PrCi({ ci, failing, summary, busy, onFix }: {
  ci: string | null | undefined; failing: string[]; summary: string[]; busy: boolean; onFix(): void;
}) {
  const label = ciLabel(ci);
  if (!label) return null;
  return (
    <span class="col" style={{ gap: '4px' }}>
      <span class={`tag small mono ${ci === 'passed' ? 's-done' : ci === 'failed' ? 's-failed' : 's-running'}`} style={{ alignSelf: 'flex-start' }}>
        {ci === 'in progress' ? <Spinner /> : ci === 'passed' ? '✔' : '✘'} {label}
      </span>
      {ci === 'failed' && (
        <>
          {failing.length > 0 && <span class="small s-failed">Failing: {failing.join(', ')}</span>}
          {summary.map(l => <span class="mono small muted" style={{ wordBreak: 'break-word' }}>{l}</span>)}
          <button type="button" class="btn btn-s btn-p" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={onFix}
            title="Write the CI failure into the task and run Implement again, then Review and Finalise">
            {busy ? <><Spinner /> Restarting…</> : 'Restart Implement with the CI failure'}
          </button>
        </>
      )}
    </span>
  );
}
