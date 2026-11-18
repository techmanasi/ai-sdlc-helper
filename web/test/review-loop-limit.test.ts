import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { afterEach } from 'vitest';
import { cleanEnv, fixture, git, pipeline, read, SLUG } from '../../test/pipeline-fixture.js';
import { startServer, type RunningServer } from '../server/index.js';

interface Launch {
  cwd: string;
  argv: string[];
  recordFile: string;
}

const { supervise } = vi.hoisted(() => ({
  supervise: vi.fn<(_job: Launch, _env: NodeJS.ProcessEnv) => number>(() => 2147483647),
}));
vi.mock('../../src/runs/supervisor.js', () => ({ startSupervisor: supervise }));

const key = 'SDLC_REVIEW_MAX_LOOPS';
const configFile = 'sdlc.config.json';
const finding = { file: 'src/sum.mjs', criterion: 'handle the edge case', reason: 'missing result' };
const changes = JSON.stringify({ verdict: 'changes', blockers: [finding], missingTests: [] });
const pass = JSON.stringify({ verdict: 'pass', blockers: [], missingTests: [] });

// Each Red tests invocation introduces a new failing case. Its Implement invocation supplies the missing module.
const stages = {
  'red-tests': `echo cases > "$FAKE_DOCS/test-cases-1.md"
n=$(grep -c '^red-tests$' "$FAKE_DIR/calls.txt")
echo "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { result } from './result$n.mjs'; test('result $n', () => assert.equal(result(), $n));" > "src/result$n.test.mjs"`,
  implement: `n=$(grep -c '^implement$' "$FAKE_DIR/calls.txt")
echo "export const result = () => $n;" > "src/result$n.mjs"`,
  review: `echo reviewed > "$FAKE_DOCS/review-1.md"
n=$(grep -c '^review$' "$FAKE_DIR/calls.txt")
if [ "$n" -le "$FAKE_REVIEW_CHANGES" ]; then echo '${changes}'; else echo '${pass}'; fi > "$FAKE_DOCS/review.json"`,
};

let server: RunningServer | undefined;
let base: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (base) await fs.promises.rm(base, { recursive: true, force: true });
  base = undefined;
  supervise.mockClear();
});

async function project(trackedLimit?: number, currentLimit?: number) {
  const f = fixture(stages);
  base = path.dirname(f.dir);
  const file = path.join(f.dir, configFile);
  const original = JSON.parse(read(f.dir, configFile));
  function configure(maxLoops?: number) {
    fs.writeFileSync(file, JSON.stringify({ ...original, review: { mode: 'single', reviewers: 3, maxLoops } }, null, 2));
  }
  configure(trackedLimit);
  git(f.dir, 'commit', '-qam', 'tracked settings');
  configure(currentLimit);
  const worktrees = path.join(base, 'worktrees');
  const env = cleanEnv({
    AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'),
    AI_SDLC_HELPER_MODELS_FILE: path.join(base, 'no-models.json'),
    SDLC_WT_BASE: worktrees,
    PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: f.fake,
  });
  server = await startServer({ cwd: f.dir, port: 0, env });
  const { port, token } = server;
  async function request(route: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/repo/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-sdlc-token': token, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: JSON.parse(await response.text()) };
  }

  async function run(slug: string, findings: number, override?: number | string) {
    const docs = `work/items/${slug}`;
    if (slug !== SLUG) {
      fs.mkdirSync(path.join(f.dir, docs), { recursive: true });
      fs.writeFileSync(path.join(f.dir, docs, 'brief.md'), 'Exercise Review.');
    }
    const before = read(f.dir, configFile);
    const response = await request(`runs/${slug}/start`, { env: {
      FAKE_DOCS: docs, FAKE_LOG: `${docs}/logs`, FAKE_REVIEW_CHANGES: String(findings),
      ...(override === undefined ? {} : { [key]: override }),
    } });
    expect(response).toMatchObject({ status: 200, data: { ok: true } });
    const [job, childEnv] = supervise.mock.lastCall!;
    expect(JSON.parse(fs.readFileSync(job.recordFile, 'utf8'))).toMatchObject({ slug, state: 'running' });
    expect(job.argv.slice(-2)).toEqual(['pipeline', slug]);
    const result = await pipeline(f, childEnv, { cwd: job.cwd, slug: job.argv[job.argv.length - 1] });
    expect(read(f.dir, configFile)).toBe(before);
    const firstReview = result.calls.indexOf('review');
    expect(firstReview, result.stdout.slice(-600)).toBeGreaterThanOrEqual(0);
    return { ...result, calls: result.calls.slice(firstReview) };
  }
  return { f, request, run, worktrees };
}

describe('project Review loop limit', () => {
  it.each([-1, 0.5])('round-trips valid settings and refuses %s without writing', async invalid => {
    const { f, request } = await project();
    const initial = await request('settings');
    expect(initial.data.config.review.maxLoops).toBe(2);
    const expected = JSON.parse(read(f.dir, configFile));
    let hash = initial.data.hash;
    for (const value of [0, 2]) {
      const saved = await request('settings', { hash, patch: { review: { maxLoops: value } } });
      expect(saved).toMatchObject({ status: 200, data: { ok: true } });
      expected.review.maxLoops = value;
      expect(JSON.parse(read(f.dir, configFile))).toEqual(expected);
      const reopened = await request('settings');
      expect(reopened.data.config.review.maxLoops).toBe(value);
      hash = reopened.data.hash;
    }
    const before = read(f.dir, configFile);
    const rejected = await request('settings', { hash, patch: { review: { maxLoops: invalid } } });
    expect(rejected.status).toBe(400);
    expect(rejected.data.errors.join(' ')).toMatch(/review\.maxLoops.*whole number.*0 or more/i);
    expect(read(f.dir, configFile)).toBe(before);
  });
});

describe('web-launched Review', () => {
  it.each([-1, '0.5', null, '', false, [0], 'nope'].map(value => ({ value })))('rejects override $value before creating the run', async ({ value }) => {
    const { f, request, worktrees } = await project(1, 1);
    const before = read(f.dir, configFile);
    const response = await request(`runs/${SLUG}/start`, { env: { [key]: value } });
    expect(response.status).toBe(400);
    expect(response.data.error).toMatch(/SDLC_REVIEW_MAX_LOOPS.*whole number.*0 or more/i);
    expect(supervise).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktrees, SLUG))).toBe(false);
    expect(fs.existsSync(path.join(f.dir, '.git/sdlc-runs', `${SLUG}.json`))).toBe(false);
    expect(read(f.dir, configFile)).toBe(before);
  });

  it('stops on the first finding at zero, then inherits one fix on another run', async () => {
    const { run } = await project(1, 1);
    const blocked = await run(SLUG, 1, '0');
    expect(blocked.calls).toEqual(['review']);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toMatch(/after 0 fix loop\(s\).*needs you/i);
    const inherited = await run('other', 1);
    expect(inherited.calls).toEqual(['review', 'red-tests', 'implement', 'review']);
    expect(inherited.status, inherited.stderr).toBe(0);
  });

  it('uses two fixes when the current project removed its tracked zero', async () => {
    const { run } = await project(0);
    const result = await run(SLUG, 3);
    expect(result.calls).toEqual(['review', 'red-tests', 'implement', 'review', 'red-tests', 'implement', 'review']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/after 2 fix loop\(s\).*needs you/i);
  });

  it('accepts numeric overrides and completes when Review passes on the last allowed round', async () => {
    const { run } = await project(0, 0);
    const immediate = await run(SLUG, 0, 0);
    expect(immediate.calls).toEqual(['review']);
    expect(immediate.status).toBe(0);
    const extended = await run('other', 2, 2);
    expect(extended.calls).toEqual(['review', 'red-tests', 'implement', 'review', 'red-tests', 'implement', 'review']);
    expect(extended.status).toBe(0);
  });
});
