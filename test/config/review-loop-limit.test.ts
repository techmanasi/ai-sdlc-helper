import { describe, it, expect } from 'vitest';
import { resolve } from '../../src/config/settings.js';
import { pipelineEnv, runContext } from '../../src/runs/index.js';
import { project } from '../helpers.js';

const message = 'must be a whole number, 0 or more';
const setup = () => project({ 'sdlc.config.json': JSON.stringify({ suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }], review: { maxLoops: 1 } }) });

describe('review loop limit run option', () => {
  it.each([['5', 5], ['0', 0], ['9007199254740991', Number.MAX_SAFE_INTEGER]])('resolves run option %s as %s', (value, expected) => {
    const dir = setup();
    const env = { SDLC_REVIEW_MAX_LOOPS: value };
    expect(resolve(dir, { env }).config?.review.maxLoops).toBe(expected);
    expect(pipelineEnv(runContext(dir, env), 'item').SDLC_REVIEW_MAX_LOOPS).toBe(value);
  });

  it.each(['-1', '1.5', 'abc', '1e1x', 'NaN', ' ', '9007199254740992'])('rejects invalid run option %j', value => {
    const dir = setup();
    const env = { SDLC_REVIEW_MAX_LOOPS: value };
    const result = resolve(dir, { env });
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toContain(`SDLC_REVIEW_MAX_LOOPS ${message}`);
  });

  it.each(['-1', '1.5', 'abc', '1e1x', 'NaN', ' ', '9007199254740992'])('refuses run context for invalid option %j', value => {
    expect(() => runContext(setup(), { SDLC_REVIEW_MAX_LOOPS: value })).toThrow(message);
  });
});
