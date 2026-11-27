import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { beginStageRound, endStageRound, noteStageRoundAgent, type RoundCtx } from '../src/pipeline/round-record.js';
import { stop, Exit } from '../src/pipeline/context.js';
import { answerQuestions } from '../src/runs/view.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function run(from = 'spec'): { ctx: RoundCtx; rows: () => Array<Record<string, unknown>>; said: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-record-'));
  dirs.push(root);
  const said: string[] = [];
  const ctx = { root, log: 'logs', out: (l: string) => { said.push(l); }, from } as unknown as RoundCtx;
  const file = path.join(root, 'logs', 'attempts.jsonl');
  const rows = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  return { ctx, rows, said };
}

describe('stage round records', () => {
  test('reaching the next stage ends the previous round as passed, with the one agent and model it used', () => {
    const { ctx, rows } = run();
    beginStageRound(ctx, 'Spec');
    noteStageRoundAgent(ctx, 'spec', 'opencode', 'big-pickle');
    beginStageRound(ctx, 'Plan');
    expect(rows()).toEqual([expect.objectContaining({ kind: 'round', stage: 'Spec', cause: 'passed', next: 'next-stage', agent: 'opencode', model: 'big-pickle', startedBy: 'run' })]);
  });

  test('Review going back to Red tests is review-changes, and the new round was started by review', () => {
    const { ctx, rows } = run('implement');
    beginStageRound(ctx, 'Review');
    beginStageRound(ctx, 'Red tests');
    endStageRound(ctx, { cause: 'check-failed', next: 'stop' });
    const [review, red] = rows();
    expect(review).toMatchObject({ stage: 'Review', cause: 'review-changes', next: 'retry', startedBy: 'resume' });
    expect(red).toMatchObject({ stage: 'Red tests', cause: 'check-failed', next: 'stop', startedBy: 'review' });
  });

  test('a stage that runs again is a retry, and a round with no known cause or with mixed agents leaves them out', () => {
    const { ctx, rows } = run();
    beginStageRound(ctx, 'Implement');
    noteStageRoundAgent(ctx, 'implement', 'claude', 'a');
    noteStageRoundAgent(ctx, 'implement', 'codex', 'b');
    beginStageRound(ctx, 'Implement');
    endStageRound(ctx, {});
    const [first, second] = rows();
    expect(first).toMatchObject({ stage: 'Implement', next: 'retry' });
    expect(first.cause).toBeUndefined();
    expect(first.agent).toBeUndefined();
    expect(second).toMatchObject({ startedBy: 'retry' });
    expect(second.cause).toBeUndefined();
    expect(second.next).toBeUndefined();
  });

  test('an audit agent of another stage does not name the round agent', () => {
    const { ctx, rows } = run();
    beginStageRound(ctx, 'Test repair');
    noteStageRoundAgent(ctx, 'test-repair', 'claude', 'm');
    noteStageRoundAgent(ctx, 'audit', 'codex', 'x');
    endStageRound(ctx, { cause: 'passed', next: 'stop' });
    expect(rows()[0]).toMatchObject({ agent: 'claude', model: 'm' });
  });

  test('ending with no open round writes nothing, and an unwritable log is reported in the run output', () => {
    const { ctx, rows, said } = run();
    endStageRound(ctx, { cause: 'passed' });
    expect(rows()).toEqual([]);
    fs.writeFileSync(path.join(ctx.root, 'logs'), 'not a directory');
    beginStageRound(ctx, 'Spec');
    endStageRound(ctx, { cause: 'passed' });
    expect(said.join('\n')).toContain('could not record the end of Spec');
  });

  test('a stop carries its cause to the run', () => {
    try { stop({ out: () => {} }, 'PAUSED', 2, 'plan', 'questions'); } catch (e) {
      expect(e).toBeInstanceOf(Exit);
      expect((e as Exit).cause).toBe('questions');
    }
  });
});

describe('answered questions', () => {
  test('answering through the controls records when each question was answered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answered-'));
    dirs.push(root);
    const file = path.join(root, 'questions.md');
    fs.writeFileSync(file, '### Q1: A\nbody\n**Suggested:** x\n**Answer:**\n### Q2: B\nbody\n**Suggested:** y\n**Answer:**\n');
    answerQuestions(file, { 1: 'yes', 2: '' });
    const rows = fs.readFileSync(path.join(root, 'logs', 'attempts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ kind: 'answered', n: 1 })]);
  });
});
