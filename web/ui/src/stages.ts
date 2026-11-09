// Decisions about what the board and the run page show, kept apart from the components so they can be tested.

/** A finished run stays on the board until its pull request is merged (a PR not read yet counts as not merged). */
export const awaitsMerge = (r: { state: string; pullRequest?: { state: string | null } | null }): boolean => r.state === 'done' && r.pullRequest?.state !== 'MERGED';

/** Resolve conflicts is on the rail only once it has run, or is running: until then Finalise holds its button. */
export function resolveShown(v: { stage: string; record: Record<string, unknown> | null; stageFiles: Record<string, string[]>; docs: string[] }): boolean {
  return v.stage === 'Resolve conflicts' || v.record?.from === 'resolve-conflicts'
    || (v.stageFiles['Resolve conflicts']?.length || 0) > 0 || v.docs.includes('logs/resolve-conflicts.json');
}

/** How the CI of a pull request reads on a card: in progress, passed or failed (nothing for a PR without checks, or before it is known). */
export function ciLabel(ci: string | null | undefined): string | null {
  return ci === 'in progress' ? 'CI in progress' : ci === 'passed' ? 'CI passed' : ci === 'failed' ? 'CI failed' : null;
}
