// What the resume panel shows about a run's handoff (logs/handoff.json), kept apart from Run.tsx so it can be tested.
// The pipeline's finding is read-only; the user's instruction is a separate, optional note (never merged with it).

/** The longest note the server accepts. */
export const MAX_NOTE = 4000;

export interface HandoffView { to: string; finding?: { from: string; reason: string }; user?: { note: string; at: string } }

export interface HandoffBlocks {
  /** "From the pipeline (<from>): <reason>", or '' when the pipeline left no finding. */
  finding: string;
  /** The note already left for the run ('' for none). */
  note: string;
  /** The textarea label for the stage picked. */
  label: (stageName: string) => string;
}

export function handoffBlocks(v: { handoff?: HandoffView | null }): HandoffBlocks {
  const h = v.handoff;
  return {
    finding: h?.finding ? `From the pipeline (${h.finding.from}): ${h.finding.reason}` : '',
    note: h?.user?.note ?? '',
    label: stageName => `Instruction for the ${stageName} agent (optional)`,
  };
}

/** Why <text> cannot be sent as a note ('' when it can; an empty note is fine: it sends nothing). */
export function noteError(text: string): string {
  const n = text.trim().length;
  return n > MAX_NOTE ? `${n} characters; at most ${MAX_NOTE}` : '';
}

/** The note to send: trimmed, undefined when empty. */
export const noteToSend = (text: string): string | undefined => text.trim() || undefined;
