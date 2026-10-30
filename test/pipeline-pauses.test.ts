import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { decide } from '../src/permissions/index.js';
import {
  DOCS, LOG, SLUG, fixture, pipeline, read, statusOf,
} from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
// A run takes seconds, and many more on a loaded machine.
vi.setConfig({ testTimeout: 300_000 });

describe('pauses for the developer', () => {
  const asking = (file: string) => `if [ ! -f "$FAKE_DOCS/decisions.md" ]; then printf '# Questions\\n\\n### Q1: Overflow\\nWhat happens on overflow?\\n**Suggested:** throw\\n**Answer:**\\n' > "$FAKE_DOCS/questions.md"; else echo done > "$FAKE_DOCS/${file}"; fi`;
  const answer = (dir: string) => {
    const q = path.join(dir, DOCS, 'questions.md');
    fs.writeFileSync(q, fs.readFileSync(q, 'utf8').replace('**Answer:**', '**Answer:** accept'));
  };

  test('Spec questions pause the run (exit 2) until every answer is filled; the answers become decisions.md', async () => {
    const f = fixture({ spec: asking('specs-1.md') });
    let r = await pipeline(f);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`PAUSED: new questions in ${DOCS}/questions.md. Fill each '**Answer:**' (write 'accept' to take the suggestion) and rerun.`);
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', stage: 'Spec' });

    r = await pipeline(f);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`PAUSED: 0/1 questions answered in ${DOCS}/questions.md.`);
    expect(r.calls).toEqual([]);

    answer(f.dir);
    r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`   recorded round 1 answers in ${DOCS}/decisions.md\n   -> agent: spec-2`);
    expect(read(f.dir, `${DOCS}/decisions.md`)).toMatch(new RegExp(`^# Decisions for ${SLUG}\\n\\n## Round 1 \\(\\d{4}-\\d\\d-\\d\\d\\)\\n\\n\\n### Q1: Overflow\\nWhat happens on overflow\\?\\n\\*\\*Suggested:\\*\\* throw\\n\\*\\*Answer:\\*\\* accept\\n$`));
    expect(fs.existsSync(path.join(f.dir, DOCS, 'questions.md'))).toBe(false);
  });

  test('Plan questions pause the run; it resumes at Plan with the answers recorded', async () => {
    const f = fixture({ plan: asking('plan-1.md') });
    let r = await pipeline(f);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`PAUSED: the Plan agent has open questions in ${DOCS}/questions.md.`);
    expect(r.stdout).toContain(`resume: ai-sdlc-helper pipeline ${SLUG} --from plan`);
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', stage: 'Plan' });
    answer(f.dir);
    r = await pipeline(f, {}, { from: 'plan' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls[0]).toBe('plan');
    expect(read(f.dir, `${DOCS}/decisions.md`)).toContain('**Answer:** accept');
  });

  test('SDLC_AUTO_ACCEPT=1 auto-accepts Spec questions and advances without pausing', async () => {
    const f = fixture({ spec: asking('specs-1.md') });
    const r = await pipeline(f, { SDLC_AUTO_ACCEPT: '1' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`SDLC_AUTO_ACCEPT: auto-accepting suggestions in ${DOCS}/questions.md (round 1)`);
    expect(r.stdout).toContain(`   recorded round 1 answers in ${DOCS}/decisions.md\n   -> agent: spec-2`);
    expect(read(f.dir, `${DOCS}/decisions.md`)).toContain('**Answer:** accept');
    expect(fs.existsSync(path.join(f.dir, DOCS, 'questions.md'))).toBe(false);
  });

  test('SDLC_AUTO_ACCEPT=1 auto-accepts Plan questions and re-runs plan without pausing', async () => {
    const f = fixture({ plan: asking('plan-1.md') });
    const r = await pipeline(f, { SDLC_AUTO_ACCEPT: '1' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`SDLC_AUTO_ACCEPT: auto-accepting suggestions in ${DOCS}/questions.md (plan attempt 1)`);
    expect(r.stdout).toContain(`   recorded round 1 answers in ${DOCS}/decisions.md`);
    expect(read(f.dir, `${DOCS}/decisions.md`)).toContain('**Answer:** accept');
    expect(fs.existsSync(path.join(f.dir, DOCS, 'questions.md'))).toBe(false);
  });

  test('a refused action pauses the run (exit 2); once allowed, the resumed stage gets the rule', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.fake, 'plan.deny'), 'Bash(git push:*)');
    let r = await pipeline(f);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`   !! agent 'plan' was refused 1 action(s): allow or deny them in the pane (or: ai-sdlc-helper permit ${SLUG} allow|always|deny all), then resume at plan`);
    const state = JSON.parse(read(f.dir, `${LOG}/permissions.json`));
    expect(state.pending).toEqual([{ stage: 'plan', tool: 'Bash', detail: 'git push origin main', rule: 'Bash(git push:*)', protected: false }]);
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', stage: 'Plan' });

    decide(path.join(f.dir, LOG, 'permissions.json'), 'all', 'allow');
    r = await pipeline(f, { FROM: 'plan' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(read(f.fake, 'args-plan.txt').split('\n')).toContain('Bash(git push:*)');
    // the baseline of the first run is kept
    expect(r.stdout).not.toContain('WARNING: no baseline');
  });
});
