// A run stopped by a signal leaves a trace, and the agents get this package's ai-sdlc-helper first on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import type { AgentRequest } from '../src/pipeline/agent.js';
import { withOwnCli } from '../src/pipeline/launcher.js';
import { stageRecoveryHint } from '../src/pipeline/hints.js';
import { pipeline as cliPipeline } from '../src/cli/pipeline.js';
import { tmp } from './helpers.js';
import { LOG, SLUG, cleanEnv, fixture, pipeline, read } from './pipeline-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

describe('a run stopped by a signal', () => {
  test('is kept in errors.log and the run output, and diagnosed as stopped from outside', async () => {
    const f = fixture();
    const controller = new AbortController();
    const spawnAgent = async (req: AgentRequest) => {
      controller.abort(); // what the SIGTERM handler of the pipeline command does
      fs.writeFileSync(req.stdout, '');
      fs.writeFileSync(req.stderr, '');
      return 1;
    };
    const r = await pipeline(f, {}, { spawnAgent, signal: controller.signal, stoppedBy: () => ({ name: 'SIGTERM', code: 143 }) });
    expect(r.status).toBe(1);
    const line = /run stopped by SIGTERM \(exit 143\) during Spec, agent (\S+)/.exec(r.stdout);
    expect(line).not.toBeNull();
    expect(read(f.dir, `${LOG}/errors.log`)).toContain(line![0]);
    const hint = stageRecoveryHint({
      slug: SLUG, stage: 'Spec', state: 'failed', exitCode: 1,
      runOut: ['SDLC: add-sum on branch b', `agent '${line![1]}' failed: interrupted`, ...r.stdout.split('\n')],
    });
    expect(hint.diagnosis).toBe(`Agent '${line![1]}' was stopped by SIGTERM (the run was killed from outside)`);
  });

  test('the pipeline command passes the signal it received on', async () => {
    const f = fixture();
    const seen: string[] = [];
    const io = { cwd: f.dir, env: cleanEnv({ PATH: `${f.bin}:${process.env.PATH}`, FAKE_DIR: f.fake, AI_SDLC_HELPER_MODELS_FILE: path.join(f.fake, 'none.json') }), out: (l: string) => { seen.push(l); if (seen.length === 1) process.emit('SIGTERM' as any); }, err: () => {} };
    // The signal comes with the run's first output line: the handlers are installed by then, whatever the run's speed.
    const code = await cliPipeline(['pipeline', SLUG], ['--from', '--cwd', '--agent', '--model', '--effort'], io as any);
    expect(code).toBe(143);
  });
});

describe('the agents\' own ai-sdlc-helper', () => {
  const ctxOf = (root: string) => ({ root, log: 'logs', out: (l: string) => { lines.push(l); } });
  let lines: string[] = [];

  test('a launcher folder comes first on PATH and runs the given bin', () => {
    const dir = tmp('launcher-');
    const bin = path.join(dir, 'bin.js');
    const pkg = path.resolve(__dirname, '../package.json');
    fs.writeFileSync(bin, `const a = process.argv.slice(2); if (a[0] === '--version') console.log(JSON.parse(require('fs').readFileSync(${JSON.stringify(pkg)}, 'utf8')).version);`);
    const env = withOwnCli(ctxOf(dir), { PATH: '/usr/bin', KEEP: '1' }, bin);
    expect(env.KEEP).toBe('1');
    const first = String(env.PATH).split(path.delimiter)[0];
    expect(String(env.PATH).endsWith(`${path.delimiter}/usr/bin`)).toBe(true);
    const r = spawnSync('ai-sdlc-helper', ['--version'], { env: { PATH: env.PATH }, encoding: 'utf8' });
    expect(r.stdout.trim()).toBe(JSON.parse(fs.readFileSync(pkg, 'utf8')).version);
    expect(fs.existsSync(path.join(first, 'ai-sdlc-helper'))).toBe(true);
  });

  test('a bin that is missing is kept in errors.log with a warning, and PATH stays as it was', () => {
    const dir = tmp('launcher-');
    lines = [];
    const env = withOwnCli(ctxOf(dir), { PATH: '/usr/bin' }, path.join(dir, 'nope.js'));
    expect(env.PATH).toBe('/usr/bin');
    expect(lines.join('\n')).toContain('WARNING: agents may run another ai-sdlc-helper');
    expect(fs.readFileSync(path.join(dir, 'logs/errors.log'), 'utf8')).toContain('nope.js');
  });
});
