import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { decide, extract, loadState, modeFor, ruleFor, rulesFor } from '../src/permissions/index.js';
import { tmp } from './helpers.js';

const CWD = '/work/repo';
let dir;
let files;

const agentJson = (denials, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', result: 'agent text', permission_denials: denials, ...extra });
const denial = (tool, input) => ({ tool_name: tool, tool_use_id: 'x', tool_input: input });
const run = (json, stage = 'implement', err = '') => {
  fs.writeFileSync(files.json, json);
  if (err) fs.writeFileSync(files.err, err);
  return extract({ jsonFile: files.json, logFile: files.log, stateFile: files.state, stage, cwd: CWD, errFile: err ? files.err : undefined });
};

let dirs: string[] = [];
// A new, empty run folder. Every test starts with one; a test that checks several cases calls it between them.
function fresh() {
  dir = tmp('sdlc-perm-');
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'logs'));
  files = { json: path.join(dir, 'a.json'), log: path.join(dir, 'a.log'), err: path.join(dir, 'a.err'), state: path.join(dir, 'logs', 'permissions.json'), repo: path.join(dir, 'repo.json') };
}
beforeEach(fresh);
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function cli(cwd: string, ...args: string[]) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, cwd });
  await new Promise(resolve => setImmediate(resolve)); // let the test runner's messages through between git-heavy calls
  return { status, stdout, stderr };
}

describe('extract', () => {
  test('writes the agent text to the log and records each refused action as pending, once, unless it was already decided', () => {
    const two = () => agentJson([denial('Bash', { command: 'git push origin main' }), denial('Edit', { file_path: `${CWD}/server/app.js` })]);

    expect(run(two())).toBe(2);
    expect(fs.readFileSync(files.log, 'utf8')).toBe('agent text\n');
    const { pending } = loadState(files.state);
    expect(pending[0]).toEqual({ stage: 'implement', tool: 'Bash', detail: 'git push origin main', rule: 'Bash(git push:*)', protected: false });
    expect(pending[1]).toEqual({ stage: 'implement', tool: 'Edit', detail: 'server/app.js', rule: 'Edit(./server/app.js)', protected: false });

    // the same refusals again are still two pending asks
    expect(run(two())).toBe(2);

    // one the developer already denied or allowed is not asked again
    decide(files.state, '0', 'deny', files.repo);
    decide(files.state, '0', 'allow', files.repo);
    expect(run(two())).toBe(0);

    // a file under .claude/ is marked protected, because no allow rule lifts that refusal
    fresh();
    run(agentJson([denial('Edit', { file_path: `${CWD}/.claude/plugins/p/hooks/register.tsx` })]));
    const [ask] = loadState(files.state).pending;
    expect(ask.protected).toBe(true);
    expect(ask.rule).toBe('Edit(./.claude/plugins/p/hooks/register.tsx)');
  });

  test('a run with no refusals leaves nothing pending: an error and a non-success end are kept in the log, non-JSON output is copied unchanged', () => {
    expect(run(agentJson([], { subtype: 'error_max_turns', result: undefined }), 'plan', 'provider said 429\n')).toBe(0);
    expect(fs.readFileSync(files.log, 'utf8')).toContain('[agent ended: error_max_turns]');
    expect(fs.readFileSync(files.log, 'utf8')).toContain('provider said 429');

    fresh();
    expect(run('plain text from an older agent\n', 'plan', 'warn\n')).toBe(0);
    expect(fs.readFileSync(files.log, 'utf8')).toBe('plain text from an older agent\nwarn\n');
  });
});

describe('decide', () => {
  const ask = () => run(agentJson([denial('Bash', { command: 'git push origin main' }), denial('Edit', { file_path: `${CWD}/.claude/plugins/p/f.tsx` })]));

  test('allow grants the rule for this run only; always also saves it in the repository file, which every later run reads', () => {
    ask();
    expect(decide(files.state, '0', 'allow', files.repo)).toBe(1);
    expect(loadState(files.state).allow).toEqual(['Bash(git push:*)']);
    expect(fs.existsSync(files.repo)).toBe(false);
    expect(rulesFor(dir, files.repo)).toEqual(['Bash(git push:*)']);

    fresh();
    ask();
    decide(files.state, '0', 'always', files.repo);
    expect(JSON.parse(fs.readFileSync(files.repo, 'utf8')).allow).toEqual(['Bash(git push:*)']);
    fs.rmSync(files.state);
    expect(rulesFor(dir, files.repo)).toEqual(['Bash(git push:*)']);
  });

  test('allowing a protected path runs that stage with the checks off, and never saves it as a rule', () => {
    ask();

    expect(modeFor(dir, 'implement')).toBe('acceptEdits');
    decide(files.state, '1', 'always', files.repo);
    expect(modeFor(dir, 'implement')).toBe('bypassPermissions');
    expect(modeFor(dir, 'review')).toBe('acceptEdits');
    expect(fs.existsSync(files.repo)).toBe(false);
    expect(loadState(files.state).allow).toEqual([]);
  });

  test('an unknown choice or number is an error and changes nothing; all decides every pending ask, and deny grants nothing', () => {
    ask();

    expect(() => decide(files.state, '0', 'maybe', files.repo)).toThrow(/allow, always or deny/);
    expect(() => decide(files.state, '9', 'allow', files.repo)).toThrow(/no pending request/);
    expect(loadState(files.state).pending).toHaveLength(2);

    expect(decide(files.state, 'all', 'deny', files.repo)).toBe(0);
    const s = loadState(files.state);
    expect(s.denied).toHaveLength(2);
    expect(s.allow).toEqual([]);
    expect(s.bypass).toEqual([]);
  });

  test('deciding a denied permission allows or always-allows it, removing from denied', () => {
    ask();
    decide(files.state, 'all', 'deny', files.repo);
    expect(loadState(files.state).denied).toHaveLength(2);

    decide(files.state, 'denied:0', 'allow', files.repo);
    let s = loadState(files.state);
    expect(s.denied).toHaveLength(1);
    expect(s.allow).toContain('Bash(git push:*)');

    decide(files.state, 'denied:0', 'always', files.repo);
    s = loadState(files.state);
    expect(s.denied).toHaveLength(0);
  });
});

describe('ruleFor', () => {
  test('gives the allow rule for a refused tool call', () => {
    const cases: [string, object, string][] = [
      ['Bash', { command: 'npm install left-pad' }, 'Bash(npm install:*)'],
      ['Bash', { command: 'make' }, 'Bash(make:*)'],
      ['Bash', { command: '$(evil)' }, 'Bash'],
      ['Write', { file_path: `${CWD}/a/b.txt` }, 'Write(./a/b.txt)'],
      ['WebFetch', { url: 'https://x.example' }, 'WebFetch'],
    ];
    for (const [tool, input, rule] of cases) expect([tool, input, ruleFor(tool, input, CWD)]).toEqual([tool, input, rule]);
  });
});

describe('command line', () => {
  test('extract prints the number of pending asks; args and mode print what the next agent run uses; a bad command exits 1', async () => {
    // nothing is pending yet
    const bad = await cli(dir, 'permissions', 'decide', files.state, '0', 'allow', files.repo);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/no pending request/);

    fs.writeFileSync(files.json, agentJson([denial('Bash', { command: 'git push origin main' })]));
    const out = await cli(dir, 'permissions', 'extract', 'a.json', 'a.log', 'logs/permissions.json', 'implement', CWD);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('1');
    expect((await cli(dir, 'permissions', 'list', files.state)).stdout.trim()).toBe(JSON.stringify(loadState(files.state).pending));
    expect((await cli(dir, 'permissions', 'decide', files.state, '0', 'allow', files.repo)).stdout.trim()).toBe('0');
    expect((await cli(dir, 'permissions', 'args', dir, 'implement', files.repo)).stdout.trim()).toBe('Bash(git push:*)');
    expect((await cli(dir, 'permissions', 'mode', dir, 'implement')).stdout.trim()).toBe('acceptEdits');

    const usage = await cli(dir, 'permissions', 'bogus');
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain('Usage: ai-sdlc-helper permissions');
  });

  test('permit decides the asks of <backlogDir>/<slug> in the project and saves always-rules in that project', async () => {
    const root = tmp('sdlc-permit-');
    dirs.push(root);
    const git = (...a: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    fs.writeFileSync(path.join(root, 'sdlc.config.json'), JSON.stringify({ backlogDir: 'work/items/' }));
    const docs = path.join(root, 'work', 'items', 'my-feature');
    fs.mkdirSync(path.join(docs, 'logs'), { recursive: true });
    const state = path.join(docs, 'logs', 'permissions.json');
    fs.writeFileSync(files.json, agentJson([denial('Bash', { command: 'git push origin main' }), denial('Bash', { command: 'npm install x' })]));
    extract({ jsonFile: files.json, logFile: files.log, stateFile: state, stage: 'implement', cwd: root });

    let r = await cli(path.join(root, 'work'), 'permit', 'my-feature', 'always', '0');
    expect([r.status, r.stdout.trim()]).toEqual([0, '1']);
    const rules = path.join(root, '.claude', 'sdlc-permissions.json');
    expect(JSON.parse(fs.readFileSync(rules, 'utf8')).allow).toEqual(['Bash(git push:*)']);

    // another worktree with its own settings and backlog is its own project: its rules are its own
    const wt = `${root}-wt`;
    dirs.push(wt);
    git('worktree', 'add', '-q', '-b', 'other', wt);
    fs.writeFileSync(path.join(wt, 'sdlc.config.json'), JSON.stringify({ backlogDir: 'work/items' }));
    const wtState = path.join(wt, 'work', 'items', 'my-feature', 'logs', 'permissions.json');
    fs.mkdirSync(path.dirname(wtState), { recursive: true });
    fs.writeFileSync(wtState, JSON.stringify({ pending: [{ stage: 'plan', tool: 'Bash', detail: 'make', rule: 'Bash(make:*)', protected: false }] }));
    r = await cli(wt, 'permit', 'my-feature', 'always');
    expect([r.status, r.stdout.trim()]).toEqual([0, '0']);
    expect(JSON.parse(fs.readFileSync(rules, 'utf8')).allow).toEqual(['Bash(git push:*)']);
    expect(JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'sdlc-permissions.json'), 'utf8')).allow).toEqual(['Bash(make:*)']);

    // the remaining ask, all at once by default, denied
    r = await cli(root, 'permit', 'my-feature', 'deny');
    expect([r.status, r.stdout.trim()]).toEqual([0, '0']);
    expect(loadState(state).denied).toEqual([{ tool: 'Bash', detail: 'npm install x' }]);

    expect(await cli(root, 'permit', 'Bad_Slug', 'allow')).toMatchObject({ status: 2, stderr: expect.stringContaining("Invalid slug 'Bad_Slug'") });
    expect(await cli(root, 'permit', 'nothing-here', 'allow')).toMatchObject({ status: 1, stderr: expect.stringContaining('No pipeline for nothing-here') });
    expect(await cli(root, 'permit', 'my-feature')).toMatchObject({ status: 2, stderr: expect.stringContaining('Usage: ai-sdlc-helper permit') });
    expect(await cli(root, 'permit', 'my-feature', 'maybe')).toMatchObject({ status: 1, stderr: expect.stringContaining('allow, always or deny') });
  });
});

describe('a refused command line with several commands', () => {
  test('is named by its first command that no allow rule covers', () => {
    const allowed = ['Bash(cd:*)', 'Bash(echo:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(git log *)', 'Bash(pwd)'];
    const cases = [
      // separators inside quotes do not split the command
      [`cd ${CWD}; sed -n '/^- New \`a;b\`/,/x|y/p' brief.md; echo ---`, 'Bash(sed:*)'],
      ['cat a.js; grep -n "x\\|y" b.js; ls s | grep -i p', 'Bash(grep:*)'],
      ['cd server && npm install pino', 'Bash(npm install:*)'],
      ['git log --oneline -3 || git status', 'Bash(git status:*)'],
      ['pwd; pwd --x', 'Bash(pwd:*)'],
      // every part allowed (refused for another reason): the first part, as before
      ['cd server; cat a.js', 'Bash(cd server:*)'],
      ['cd server', 'Bash(cd server:*)'],
    ];
    for (const [command, rule] of cases) expect([command, ruleFor('Bash', { command }, CWD, allowed)]).toEqual([command, rule]);
  });

  test('extract names it by the part the agent was not allowed (SDLC_ALLOWED for the command), and does not ask again once allowed', async () => {
    const line = `cd ${CWD}; sed -n 1,5p a.md; echo ---`;
    fs.writeFileSync(files.json, agentJson([denial('Bash', { command: line })]));
    const saved = process.env.SDLC_ALLOWED;
    process.env.SDLC_ALLOWED = 'Bash(cd:*)\nBash(echo:*)\n';
    let r;
    try { r = await cli(dir, 'permissions', 'extract', files.json, files.log, files.state, 'spec', CWD); } finally {
      if (saved === undefined) delete process.env.SDLC_ALLOWED; else process.env.SDLC_ALLOWED = saved;
    }
    expect(r.stdout.trim()).toBe('1');
    expect(loadState(files.state).pending[0]).toMatchObject({ detail: line, rule: 'Bash(sed:*)' });

    decide(files.state, '0', 'allow', files.repo);
    fs.writeFileSync(files.json, agentJson([denial('Bash', { command: line })]));
    expect(extract({ jsonFile: files.json, logFile: files.log, stateFile: files.state, stage: 'spec', cwd: CWD, allowed: ['Bash(cd:*)', 'Bash(echo:*)'] })).toBe(0);
  });
});

describe('package-manager scripts', () => {
  test('a refused `npm run <script>` (and pnpm, yarn, bun) asks for that script only, not every script', () => {
    const rule = (command: string) => ruleFor('Bash', { command }, CWD);
    expect(rule('npm run generate-spec --prefix server')).toBe('Bash(npm run generate-spec:*)');
    expect(rule('pnpm run build:prod')).toBe('Bash(pnpm run build:prod:*)');
    expect(rule('yarn exec tsc --noEmit')).toBe('Bash(yarn exec tsc:*)');
    expect(rule('npm run-script lint')).toBe('Bash(npm run-script lint:*)');
    // no script name, or an option where it would be: the two words, as before
    expect(rule('npm run')).toBe('Bash(npm run:*)');
    expect(rule('npm run --silent x')).toBe('Bash(npm run:*)');
    expect(rule('npm install pino')).toBe('Bash(npm install:*)');
    expect(rule('make run tests')).toBe('Bash(make run:*)');
  });
});
