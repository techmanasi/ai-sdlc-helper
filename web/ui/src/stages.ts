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

/** Test repair has started or is over: it ran, is running or failed, or the run is past it. */
export function testRepairStarted(v: { stage: string; state: string; stageFiles: Record<string, string[]>; docs: string[] }): boolean {
  return ['Test repair', 'Review', 'Finalise', '6/6 Finalise', 'Resolve conflicts'].includes(v.stage) || v.state === 'done'
    || (v.stageFiles['Test repair']?.length || 0) > 0 || v.docs.includes('test-repair-1.md');
}

/** The test defect claims panel (test-issues.md): only while Implement is over and Test repair has not started. */
export function showTestIssues(v: { testIssues?: string | null; stage: string; state: string; stageFiles: Record<string, string[]>; docs: string[] }): boolean {
  return v.testIssues !== undefined && v.testIssues !== null && !testRepairStarted(v);
}

/**
 * Splits a question's text into plain text and the paths of this task's files (as the viewer knows them: relative to the task folder),
 * so a path written as docs/backlog/<slug>/logs/x.md or logs/x.md can open in the viewer. Only files in `docs` become links.
 */
export function linkPaths(text: string, docs: string[], slug: string): Array<string | { path: string }> {
  const known = new Set(docs);
  const parts: Array<string | { path: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:md|json|log|out|txt|diff)/g)) {
    const raw = m[0];
    const at = raw.indexOf(`/${slug}/`);
    const path = [raw, at >= 0 ? raw.slice(at + slug.length + 2) : ''].find(c => c && known.has(c));
    if (!path) continue;
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ path });
    last = m.index! + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export interface StepBanner { label: string; position: string; stage: string; percent: number; started: string }

/**
 * The banner under the Stages pane: what the stage is doing now. Only a running run with a step shows one, so a paused,
 * failed, stopped (dead pid) or finished run, and a status.json written before steps existed, show none and nothing spins.
 */
export function stepBanner(v: { state: string; stage: string; step?: { i: number; n: number; label: string; started: string } }): StepBanner | null {
  const s = v.step;
  if (v.state !== 'running' || !s || !(s.n > 0) || !(s.i >= 1) || s.i > s.n) return null;
  return {
    label: s.label,
    position: `step ${s.i} of ${s.n}`,
    stage: v.stage.replace(/^\d+\/\d+\s+/, ''),
    percent: Math.round(((s.i - 1) / s.n) * 100),
    started: s.started,
  };
}

/** "1m 05s" / "12s" since `started` (an ISO time); '' when it cannot be read. */
export function elapsedText(started: string, now: number): string {
  const t = Date.parse(started);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}
