// The note a stop leaves for the stage the run returns to: written when a stop names its resume stage, handed to that stage's agent
// at the next start, and set aside once that agent finished.
import fs from 'node:fs';
import { FROM_STAGES, at, setAside, stamp, type Ctx, type From } from './context.js';

/** The stages whose prompt holds {{HANDOFF}}. */
export const HANDOFF_STAGES: readonly From[] = ['spec', 'plan', 'red-tests', 'implement'];

/** What the pipeline found (written by the harness only) and what the user said (written from the UI only); never merged. */
export interface Finding { from: string; reason: string; at: string }
export interface UserNote { note: string; at: string }
export interface Handoff { to: From; finding?: Finding; user?: UserNote }

const MAX_REASON = 8000;

const file = (ctx: Pick<Ctx, 'log'>): string => `${ctx.log}/handoff.json`;

/** The text the agent reads: the pipeline's finding first, then the user's instruction, each as its own labelled block. */
export function handoffText(h: Pick<Handoff, 'finding' | 'user'>): string {
  const blocks: string[] = [];
  if (h.finding) blocks.push(`Why this stage is running again (from the pipeline, ${h.finding.from}):\n${h.finding.reason}`);
  if (h.user) blocks.push(`Instruction from the user:\n${h.user.note}`);
  return blocks.join('\n\n');
}

/** The file as written, or null when it is missing, unreadable or holds neither part. */
export function readHandoff(ctx: Pick<Ctx, 'root' | 'log'>): Handoff | null {
  let h: any;
  try { h = JSON.parse(fs.readFileSync(at(ctx, file(ctx)), 'utf8')); } catch { return null; }
  if (!h || typeof h !== 'object' || typeof h.to !== 'string') return null;
  const finding = h.finding && typeof h.finding.reason === 'string' ? { from: String(h.finding.from ?? ''), reason: h.finding.reason, at: String(h.finding.at ?? '') } : undefined;
  const user = h.user && typeof h.user.note === 'string' && h.user.note ? { note: h.user.note, at: String(h.user.at ?? '') } : undefined;
  if (!finding && !user) return null;
  return { to: h.to as From, ...(finding ? { finding } : {}), ...(user ? { user } : {}) };
}

function save(ctx: Pick<Ctx, 'root' | 'log'>, h: Handoff): void {
  fs.mkdirSync(at(ctx, ctx.log), { recursive: true });
  fs.writeFileSync(at(ctx, file(ctx)), `${JSON.stringify(h, null, 2)}\n`);
}

/**
 * Harness: writes the pipeline's finding for <to>, replacing any earlier one. The user's note stays only when it is for the same
 * stage; a finding for another stage clears it.
 */
export function writeHandoff(ctx: Pick<Ctx, 'root' | 'log'>, note: { to: From; from: string; reason: string }): void {
  const before = readHandoff(ctx);
  save(ctx, {
    to: note.to,
    finding: { from: note.from, reason: note.reason.slice(0, MAX_REASON), at: stamp() },
    ...(before?.user && before.to === note.to ? { user: before.user } : {}),
  });
}

/** UI/server: writes the user's instruction for <to>; the finding is never touched. An empty note changes nothing. */
export function writeUserNote(ctx: Pick<Ctx, 'root' | 'log'>, note: { to: From; text: string }): void {
  const text = note.text.trim();
  if (!text) return;
  const before = readHandoff(ctx);
  save(ctx, { to: note.to, ...(before?.finding ? { finding: before.finding } : {}), user: { note: text, at: stamp() } });
}

/**
 * The note for a run starting at <start>: the file's `to` is <start> or a later stage the start runs through. Nothing when there
 * is no readable file, `to` is before <start>, or `to` is a stage whose prompt has no {{HANDOFF}}.
 */
export function takeHandoff(ctx: Pick<Ctx, 'root' | 'log'>, start: From): (Handoff & { text: string }) | null {
  const h = readHandoff(ctx);
  if (!h || !HANDOFF_STAGES.includes(h.to)) return null;
  if (FROM_STAGES.indexOf(h.to) < FROM_STAGES.indexOf(start)) return null;
  return { ...h, text: handoffText(h) };
}

/** Sets the handoff file aside: the stage that used it finished. */
export function consumeHandoff(ctx: Pick<Ctx, 'root' | 'log'>): void {
  setAside(ctx, [file(ctx)]);
}
