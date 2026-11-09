import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { Git } from '../src/pipeline/git.js';
import {
  agentFacts, appendRound, changedBetween, debugLeftovers, readRounds, repeatedFailures, roundWarnings, snapshot,
  type AgentRound,
} from '../src/pipeline/observe.js';
import { tmp } from './helpers.js';

function repo(): { root: string; git: Git } {
  const root = fs.realpathSync(tmp());
  const run = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.ts'), "export const a = 1;\nconsole.error('DEBUG old');\n");
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return { root, git: new Git(root) };
}

const round = (over: Partial<AgentRound> = {}): AgentRound => ({
  kind: 'agent', at: '2026-11-10T00:00:00', stage: 'implement', agent: 'impl-1', durationSec: 1, exitCode: 0, responseChars: 5,
  turns: 1, tokens: 1, denied: [], filesChanged: ['a.ts'], warnings: [], ...over,
});

describe('what a round changed', () => {
  test('lists the files whose content differs, new files included, and ignores logs and untouched files', () => {
    const { root, git } = repo();
    const before = snapshot(git);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
    fs.mkdirSync(path.join(root, 'docs/backlog/x/logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/backlog/x/logs/run.out'), 'noise');
    expect(changedBetween(before, snapshot(git))).toEqual(['a.ts', 'b.ts']);
    expect(changedBetween(snapshot(git), snapshot(git))).toEqual([]);
  });

  test('a file edited and then restored to its first dirty state is not a change', () => {
    const { root, git } = repo();
    fs.writeFileSync(path.join(root, 'a.ts'), 'x\n');
    const before = snapshot(git);
    fs.writeFileSync(path.join(root, 'a.ts'), 'y\n');
    fs.writeFileSync(path.join(root, 'a.ts'), 'x\n');
    expect(changedBetween(before, snapshot(git))).toEqual([]);
  });
});

describe('debug code left in the source', () => {
  test('flags added DEBUG output and a log written under /tmp, in tracked and new files, not older lines or plain logging', () => {
    const { root, git } = repo();
    fs.appendFileSync(path.join(root, 'a.ts'), [
      "console.error('DEBUG SETUP BODY:', body);",
      "fs.writeFileSync('/tmp/debug-error.log', msg, { flag: 'a' });",
      "console.log('listening');",
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'fresh.ts'), "const x = 1;\nconsole.log(`DEBUG ${x}`);\n");
    fs.writeFileSync(path.join(root, 'notes.txt'), 'DEBUG in prose is fine\n');
    const found = debugLeftovers(git, ['a.ts', 'fresh.ts', 'notes.txt']);
    expect(found).toEqual([
      "a.ts:3: console.error('DEBUG SETUP BODY:', body);",
      "a.ts:4: fs.writeFileSync('/tmp/debug-error.log', msg, { flag: 'a' });",
      'fresh.ts:2: console.log(`DEBUG ${x}`);',
    ]);
  });

  test('finds nothing in a file that has no added debugging', () => {
    const { root, git } = repo();
    fs.appendFileSync(path.join(root, 'a.ts'), 'export const b = 2;\n');
    expect(debugLeftovers(git, ['a.ts'])).toEqual([]);
  });
});

describe('agentFacts', () => {
  const read = (data: unknown) => {
    const file = path.join(tmp(), 'r.json');
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    return agentFacts(file);
  };

  test('reads an agy result: duration, turns, tokens, the empty answer and the refused tool', () => {
    expect(read({ response: '', duration_seconds: 83.7, num_turns: 1, usage: { total_tokens: 85308 }, denied_actions: [{ action: 'read_file' }] })).toEqual({
      durationSec: 83.7, turns: 1, tokens: 85308, responseChars: 0, denied: [{ tool: 'read_file', detail: '' }],
    });
  });

  test('reads a claude result: milliseconds, token sum, refused tool', () => {
    expect(read({ result: ' done ', duration_ms: 1234, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [{ tool_name: 'Bash' }] })).toEqual({
      durationSec: 1.2, turns: 3, tokens: 15, responseChars: 4, denied: [{ tool: 'Bash', detail: '' }],
    });
  });

  test('gives nothing for a file that is missing or not JSON', () => {
    expect(agentFacts(path.join(tmp(), 'none.json')).denied).toEqual([]);
    expect(read('not json').turns).toBeNull();
  });
});

describe('roundWarnings', () => {
  const opts = { editsCode: true, debug: [] as string[] };
  const base = { exitCode: 0, responseChars: 10, denied: [], filesChanged: ['a.ts'] };

  test('a round that did its work has no warning', () => {
    expect(roundWarnings(base, opts)).toEqual([]);
  });

  test('names a refused tool (with its target when the harness gives one), an empty answer and no changes', () => {
    expect(roundWarnings({ ...base, responseChars: 0, filesChanged: [], denied: [{ tool: 'read_file', detail: '' }] }, opts)).toEqual([
      'refused read_file', 'empty answer: the agent said nothing', 'no files changed in this round',
    ]);
    expect(roundWarnings({ ...base, denied: [{ tool: 'Bash', detail: 'git push origin main' }] }, opts)).toEqual(['refused Bash git push origin main']);
  });

  test('a stage that does not edit code is not blamed for changing nothing', () => {
    expect(roundWarnings({ ...base, filesChanged: [] }, { ...opts, editsCode: false })).toEqual([]);
  });

  test('names debug code and does not warn about an empty answer when the agent failed', () => {
    expect(roundWarnings({ ...base, exitCode: 3, responseChars: 0 }, { ...opts, debug: ['a.ts:3: console.error(\'DEBUG x\')'] })).toEqual([
      "debug code left in the source: a.ts:3: console.error('DEBUG x')",
    ]);
  });
});

describe('repeatedFailures', () => {
  test('is true only for the same failing set as before', () => {
    expect(repeatedFailures(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(repeatedFailures(['a'], ['a', 'b'])).toBe(false);
    expect(repeatedFailures(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(repeatedFailures(null, ['a'])).toBe(false);
    expect(repeatedFailures(['a'], [])).toBe(false);
  });
});

describe('the rounds file', () => {
  test('a started round shows as running until its finished round replaces it, and a gate result attaches to its round', () => {
    const dir = tmp();
    appendRound(dir, { kind: 'run', at: 't0', from: 'implement' });
    appendRound(dir, { kind: 'start', at: 't1', stage: 'implement', agent: 'impl-1' });
    expect(readRounds(dir)).toMatchObject([{ agent: 'impl-1', running: true }]);
    appendRound(dir, round());
    appendRound(dir, { kind: 'gate', at: 't2', agent: 'impl-1', failing: ['x'], warnings: ['same'] });
    appendRound(dir, { kind: 'start', at: 't3', stage: 'implement', agent: 'impl-2' });
    const rounds = readRounds(dir);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ agent: 'impl-1', gate: { failing: ['x'] } });
    expect(rounds[0].running).toBeUndefined();
    expect(rounds[1]).toMatchObject({ agent: 'impl-2', running: true });
  });

  test('only the rounds since the last pipeline start are returned, and a damaged line is skipped', () => {
    const dir = tmp();
    appendRound(dir, round({ agent: 'impl-9' }));
    appendRound(dir, { kind: 'run', at: 't', from: 'spec' });
    fs.appendFileSync(path.join(dir, 'attempts.jsonl'), '{not json\n');
    appendRound(dir, round({ agent: 'impl-1' }));
    expect(readRounds(dir).map(r => r.agent)).toEqual(['impl-1']);
    expect(readRounds(path.join(dir, 'missing'))).toEqual([]);
  });
});
