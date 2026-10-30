import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from './helpers.js';
import {
  DOCS, LOG, SLUG, cleanEnv, fixture, git, pipeline, read,
} from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
// A run takes seconds, and many more on a loaded machine.
vi.setConfig({ testTimeout: 300_000 });

describe('the integration suite', () => {
  const withIntegration = (cmd: string) => {
    const f = fixture();
    const file = path.join(f.dir, 'sdlc.config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), integration: { cmd } }));
    git(f.dir, 'commit', '-qam', 'integration');
    return f;
  };

  test('runs after the unit tests; a failure fails the green gate with its log', async () => {
    const f = withIntegration('echo integration ran; exit 3');
    const r = await pipeline(f, { MAX_ATTEMPTS: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`GREEN GATE FAILED after 1 attempts and no test defect was claimed. See ${LOG}/integration.log`);
    expect(read(f.dir, `${LOG}/integration.log`)).toBe('integration ran\n');
  });

  test('in CI it is skipped with a warning unless SDLC_INTEGRATION_CI=run', async () => {
    let f = withIntegration('exit 3');
    let r = await pipeline(f, { CI: 'true' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARNING: integration tests skipped in CI; set SDLC_INTEGRATION_CI=run (or integration.ci "run") once CI can run them.');
    expect(read(f.dir, `${LOG}/integration.log`)).toContain('WARNING: integration tests skipped in CI');

    f = withIntegration('exit 3');
    r = await pipeline(f, { CI: 'true', SDLC_INTEGRATION_CI: 'run', MAX_ATTEMPTS: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`See ${LOG}/integration.log`);
  });
});

describe('the pipeline command', () => {
  const cliEnv = (f, extra = {}) => cleanEnv({ FAKE_DIR: f.fake, FAKE_DOCS: DOCS, PATH: `${f.bin}:${process.env.PATH}`, ...extra });

  test('an unknown FROM exits 1 with the message and creates nothing; every valid FROM is accepted', async () => {
    const f = fixture();
    fs.rmSync(path.join(f.dir, DOCS, 'brief.md'));
    for (const from of ['bogus', 'Implement', 'test_repair', 'TEST-REPAIR', 'Review']) {
      const r = await run(['pipeline', SLUG], cliEnv(f, { FROM: from }), f.dir);
      expect([from, r.status]).toEqual([from, 1]);
      expect(r.stdout).toContain(`ERROR: unknown FROM=${from} (use spec, plan, red-tests, implement, test-repair, review or finalise)`);
      expect(fs.existsSync(path.join(f.dir, LOG))).toBe(false);
      expect(git(f.dir, 'branch', '--list')).toBe('* main');
    }
    expect((await run(['pipeline', SLUG, '--from', 'nope'], cliEnv(f), f.dir)).stdout).toContain('ERROR: unknown FROM=nope');
    for (const from of ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'review', 'finalise']) {
      const r = await run(['pipeline', SLUG, '--from', from], cliEnv(f), f.dir);
      expect([from, r.status, r.stdout]).toEqual([from, 1, `Missing ${DOCS}/brief.md\n`]);
    }
  });

  test('no slug: the first pending backlog item; --cwd picks the checkout', async () => {
    const f = fixture();
    const r = await run(['pipeline', '--cwd', f.dir], cliEnv(f, { AI_SDLC_HELPER_MODELS_FILE: path.join(f.fake, 'none.json') }), '/');
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`SDLC: ${SLUG} on branch feature/${SLUG}`);
  });

  test('unusable settings fail before anything is written', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, 'sdlc.config.json'), '{ "suites": 3 }');
    const r = await run(['pipeline', SLUG], cliEnv(f), f.dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ERROR: sdlc.config.json: suites: must be a list\nERROR: fix the project settings above (ai-sdlc-helper show)');
    expect(fs.existsSync(path.join(f.dir, LOG))).toBe(false);
  });
});
