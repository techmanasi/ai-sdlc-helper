import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, resolve } from '../src/config/settings.js';
import { Status } from '../src/pipeline/status.js';
import { PROMPTS_DIR } from '../src/pipeline/prompts.js';
import { reviewPanel } from '../src/pipeline/review-panel.js';
import type { AgentSpawn } from '../src/pipeline/agent.js';
import type { Ctx } from '../src/pipeline/context.js';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

/**
 * A run context from real settings, whose agents are <answer>(reviewer or judge): each one's output is written as
 * claude --output-format json would print it. Every call is recorded.
 */
function context(answer: (who: string) => string, env: NodeJS.ProcessEnv = {}) {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-panel-')));
  fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ agent: { codeSearch: 'none' }, suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }] }));
  const log = 'docs/backlog/x/logs';
  fs.mkdirSync(path.join(dir, log), { recursive: true });
  const r = resolve(dir, { env });
  if (!r.config) throw new Error(r.errors.join('\n'));
  const calls: string[] = [];
  const spawnAgent: AgentSpawn = async req => {
    const who = path.basename(req.stdout).replace(/\.json$/, '');
    calls.push(who);
    fs.writeFileSync(req.stdout, `${JSON.stringify({ type: 'result', subtype: 'success', result: answer(who) })}\n`);
    return 0;
  };
  const out: string[] = [];
  const ctx = {
    root: dir, config: r.config, layout: layout(r.config), slug: 'x', from: 'resolve-conflicts', fromN: 8, docs: 'docs/backlog/x', log,
    backlog: 'docs/backlog', branch: 'sdlc/x', env, envModels: {}, force: {}, registryFile: path.join(dir, 'no-models.json'),
    limits: { maxAttempts: 1, maxTurns: 1, maxRepairTests: 1 }, status: new Status(path.join(dir, log, 'status.json'), 'x'),
    spawnAgent, promptsDir: PROMPTS_DIR, guide: '', allowed: [], testFileCmd: 't', fetchCmd: 'f', redSha: '', lockSha: '', origRedSha: '',
    failLog: `${log}/tests.log`, out: (l: string) => { out.push(l); }, err: () => {},
  } as unknown as Ctx;
  return { ctx, calls, out, log };
}

const spec = (log: string) => ({ name: '1', reviewPrompt: 'resolve-review', title: 'Review of a.ts', doubt: 'unsure', logFile: `${log}/panel.md` });
const DIFFERENT = { MODEL_RESOLVE_REVIEW_1: 'opus', MODEL_RESOLVE_REVIEW_2: 'sonnet', MODEL_RESOLVE_REVIEW_3: 'haiku' };

describe('reviewPanel', () => {
  it('unanimous SAFE: every reviewer is asked, no judge, the record says so', async () => {
    const { ctx, calls, log } = context(() => 'fine\nVERDICT: SAFE', DIFFERENT);
    const p = await reviewPanel(ctx, spec(log));
    expect(p).toMatchObject({ ran: true, safe: true, safeCount: 3, count: 3, conclusion: '' });
    expect(p.opinions.map(o => o.verdict)).toEqual(['SAFE', 'SAFE', 'SAFE']);
    expect(calls.sort()).toEqual(['resolve-review-1-1', 'resolve-review-2-1', 'resolve-review-3-1']);
    expect(fs.readFileSync(path.join(ctx.root, log, 'panel.md'), 'utf8')).toContain('3 of 3 reviewers found it safe');
  });

  it('one UNSAFE: not safe, and the judge writes the conclusion', async () => {
    const { ctx, calls, log } = context(who => (who.startsWith('resolve-judge') ? 'Keep the doubt.' : who === 'resolve-review-2-1' ? 'VERDICT: UNSAFE' : 'VERDICT: SAFE'), DIFFERENT);
    const p = await reviewPanel(ctx, spec(log));
    expect(p).toMatchObject({ ran: true, safe: false, safeCount: 2, count: 3, conclusion: 'Keep the doubt.' });
    expect(calls).toContain('resolve-judge-1');
    expect(fs.existsSync(path.join(ctx.root, log, 'panel-input.md'))).toBe(true);
  });

  it('two reviewers on one model: no reviewer is asked', async () => {
    const { ctx, calls, log } = context(() => 'VERDICT: SAFE', { MODEL_RESOLVE_REVIEW_1: 'opus', MODEL_RESOLVE_REVIEW_2: 'opus', MODEL_RESOLVE_REVIEW_3: 'haiku' });
    const p = await reviewPanel(ctx, spec(log));
    expect(p.ran).toBe(false);
    expect(p.safe).toBe(false);
    expect(p.notRun).toContain('reviewers 1 and 2 use the same model');
    expect(calls).toEqual([]);
  });
});
