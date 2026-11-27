import { describe, it, expect } from 'vitest';
import * as env from '../web/ui/src/env.js';

type Rows = [string, string][];
type ReviewConfig = { review?: { maxLoops?: number } };
type SettingsResult = { error: string; patch: { review?: { maxLoops: number } } };
type RunOptions = { error: string; env: Record<string, string>; summary: string; canLaunch: boolean };

// These helpers are the testable contract for the logic currently inline in the UI forms.
const helpers = env as typeof env & {
  reviewLimitError(rows: Rows): string;
  reviewSettingsDraft(config: ReviewConfig): string;
  reviewSettingsPatch(config: ReviewConfig, draft: string): SettingsResult;
  reviewLimitOptions(rows: Rows): RunOptions;
};
const key = 'SDLC_REVIEW_MAX_LOOPS';
const requirement = /whole number of 0 or more/i;

describe('project Review limit form', () => {
  it.each([
    { name: 'default', config: {}, draft: '2' },
    { name: 'configured zero', config: { review: { maxLoops: 0 } }, draft: '0' },
  ])('initializes the $name draft', ({ config, draft }) => {
    expect(helpers.reviewSettingsDraft(config)).toBe(draft);
  });

  it.each(['-1', '0.5', '', 'abc'])('refuses project draft %j without a review patch', draft => {
    const result = helpers.reviewSettingsPatch({}, draft);
    expect(result.error).toMatch(requirement);
    expect(result.patch).not.toHaveProperty('review');
  });

  it('patches a changed zero and omits an unchanged effective value', () => {
    expect(helpers.reviewSettingsPatch({}, '0')).toEqual({ error: '', patch: { review: { maxLoops: 0 } } });
    expect(helpers.reviewSettingsPatch({}, '2')).toEqual({ error: '', patch: {} });
    expect(helpers.reviewSettingsPatch({ review: { maxLoops: 0 } }, '0')).toEqual({ error: '', patch: {} });
  });
});

describe('run Review limit options', () => {
  it('treats an empty environment row as unset', () => {
    const rows: Rows = [[key, '']];
    expect(helpers.reviewLimitError(rows)).toBe('');
    expect(env.envVars(rows)).not.toHaveProperty(key);
    expect(helpers.reviewLimitOptions(rows)).toMatchObject({ error: '', env: {}, canLaunch: true });
  });

  it.each([
    { name: 'negative', row: [key, '-1'] as [string, string] },
    { name: 'fraction with whitespace in key', row: [` ${key}`, '0.5'] as [string, string] },
    { name: 'fraction', row: [key, '1.5'] as [string, string] },
  ])('rejects the $name override before launch or persistence', ({ row }) => {
    const rows: Rows = [row, ['OTHER', 'kept']];
    expect(helpers.reviewLimitError(rows)).toMatch(requirement);
    const result = helpers.reviewLimitOptions(rows);
    expect(result.error).toMatch(requirement);
    expect(result.env).toEqual({ OTHER: 'kept' });
    expect(result.canLaunch).toBe(false);
  });

  it('keeps zero in the environment and summary and removes it when cleared', () => {
    const rows: Rows = [[key, '0']];
    expect(env.envVars(rows)).toEqual({ [key]: '0' });
    expect(helpers.reviewLimitOptions(rows)).toMatchObject({
      error: '', env: { [key]: '0' }, summary: 'review loop limit 0', canLaunch: true,
    });
    const cleared = env.setEnvValue(rows, key, '');
    expect(env.envVars(cleared)).not.toHaveProperty(key);
    expect(helpers.reviewLimitOptions(cleared)).toMatchObject({ error: '', env: {}, canLaunch: true });
  });
});
