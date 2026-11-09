import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { answerQuestions, parseQuestions } from '../src/runs/view.js';
import { recordAnswers } from '../src/pipeline/stages.js';
import { Exit, type Ctx } from '../src/pipeline/context.js';
import { AgyHarness, agyRule } from '../src/pipeline/harness/agy.js';
import { tmp } from './helpers.js';

const NO_ANSWER_LINES = '# Questions\n\n### Q1: One\nbody\n**Suggested:** a\n\n### Q2: Two\nbody\n**Answer:** done\n';

describe('answerQuestions on a block without an Answer line', () => {
  test('saves the answer', () => {
    const file = path.join(tmp(), 'questions.md');
    fs.writeFileSync(file, NO_ANSWER_LINES);
    expect(answerQuestions(file, { 1: 'use a hash' })).toEqual({ total: 2, answered: 2 });
    expect(parseQuestions(fs.readFileSync(file, 'utf8')).map(q => q.answer)).toEqual(['use a hash', 'done']);
  });
});

describe('recordAnswers', () => {
  const setup = (text: string) => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'questions.md'), text);
    const out: string[] = [];
    return { ctx: { root, docs: 'docs', slug: 's', out: (l: string) => out.push(l) } as unknown as Ctx, out, root };
  };

  test('a questions file missing Answer lines pauses (exit 2) counting only filled answers', () => {
    const { ctx, out } = setup(NO_ANSWER_LINES);
    let code = 0;
    try { recordAnswers(ctx); } catch (e) { code = (e as Exit).code; }
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('1/2 questions answered');
  });

  test('records the round once every question is answered', () => {
    const { ctx, root } = setup(NO_ANSWER_LINES.replace('**Suggested:** a', '**Answer:** x'));
    recordAnswers(ctx);
    expect(fs.existsSync(path.join(root, 'docs', 'questions.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'docs', 'decisions.md'), 'utf8')).toContain('**Answer:** x');
  });
});

describe('agy permission rules', () => {
  test('agyRule translates Claude tool names', () => {
    expect(agyRule('Bash')).toBe('command(*)');
    expect(agyRule('Bash(npm run check:*)')).toBe('command(npm run check:*)');
    expect(agyRule('git status')).toBe('command(git status)');
  });

  test('agyRule allows a refused agy tool under its own name, for any target', () => {
    expect(agyRule('read_file')).toBe('read_file(*)');
    expect(agyRule('write_file')).toBe('write_file(*)');
  });

  test('compileStageArgs puts the translated rules in --settings', () => {
    const inv = new AgyHarness().compileStageArgs({ prompt: 'p', stage: 'spec', mode: 'bypass', allowedCommands: ['Bash', 'Bash(npm run check:*)'] });
    const settings = JSON.parse(inv.args[inv.args.indexOf('--settings') + 1]);
    expect(settings).toEqual({ permissions: { allow: ['command(*)', 'command(npm run check:*)'] } });
  });
});
