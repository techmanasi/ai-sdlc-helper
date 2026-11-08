import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pr from '../../src/pipeline/finalise.js';
import { spawnSync } from '../../src/trace.js';
import { execFile } from 'node:child_process';

vi.mock('../../src/trace.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/trace.js')>(), spawnSync: vi.fn(), trace: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn() }));
const url = 'https://github.com/acme/repo/pull/12';
const response = (stdout: string, status = 0) => ({ status, stdout, stderr: '', pid: 1, output: [], signal: null });
beforeEach(() => { vi.clearAllMocks(); pr.clearPrCache(); });
afterEach(() => { vi.useRealTimers(); });

describe('PR metadata and draft lifecycle (spec 4, 5, 9)', () => {
  it('P01 preserves draft and check metadata through the synchronous lookup and URL cache', () => {
    const checks = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/repo/actions/runs/7' }];
    vi.mocked(spawnSync).mockReturnValue(response(JSON.stringify({ url, state: 'OPEN', number: 12, isDraft: true, statusCheckRollup: checks })));
    const value = pr.getPrStatus('/fixture', 'sdlc/feature', {});
    expect(value).toMatchObject({ url, isDraft: true, statusCheckRollup: checks });
    expect(pr.getPrStatus('/fixture', url, {})).toEqual(value);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const fields = vi.mocked(spawnSync).mock.calls[0][1] as string[];
    expect(fields[fields.indexOf('--json') + 1].split(',')).toEqual(expect.arrayContaining(['url', 'state', 'number', 'isDraft', 'statusCheckRollup']));
  });
  it('P02 preserves CI metadata through the asynchronous web refresh', async () => {
    const data = { url, state: 'OPEN', number: 12, isDraft: false, statusCheckRollup: [] };
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, JSON.stringify(data), ''));
      return {};
    }) as typeof execFile);
    expect((await pr.getPrStatusAsync('/fixture', url, {})).status).toMatchObject(data);
  });
  it('P03 expires the shared status cache after sixty seconds', () => {
    vi.useFakeTimers();
    vi.mocked(spawnSync).mockReturnValue(response(JSON.stringify({ url, state: 'OPEN', isDraft: true })));
    pr.getPrStatus('/fixture', url, {});
    vi.advanceTimersByTime(59_999);
    pr.getPrStatus('/fixture', url, {});
    expect(spawnSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    pr.getPrStatus('/fixture', url, {});
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
  it('P04 creates a draft against the recorded base', () => {
    vi.mocked(spawnSync).mockImplementation((_command, args) => response(args?.includes('create') ? `${url}\n` : '', args?.includes('create') ? 0 : 1));
    const create = pr.createOrGetPr as (...args: unknown[]) => string | null;
    expect(create('/fixture', 'sdlc/feature', 'Feature', 'Body', 'release', { draft: true })).toBe(url);
    const call = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.includes('create'));
    expect(call?.[1]).toEqual(expect.arrayContaining(['--draft', '--base', 'release', '--head', 'sdlc/feature']));
  });
  it('P05 reuses an existing ready PR without changing its draft status', () => {
    vi.mocked(spawnSync).mockReturnValue(response(`${url}\n`));
    const create = pr.createOrGetPr as (...args: unknown[]) => string | null;
    expect(create('/fixture', 'sdlc/feature', 'Feature', 'Body', 'main', { draft: true })).toBe(url);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0][1]?.[1]).toBe('view');
  });
  it.each([0, 1])('P06 marks an existing PR ready and reports command status %i', async status => {
    vi.mocked(spawnSync).mockReturnValue(response('', status));
    const module = await import('../../src/pipeline/finalise.js');
    expect(module.markPrReady('/fixture', url, {})).toBe(status === 0);
    expect(spawnSync).toHaveBeenCalledWith('gh', ['pr', 'ready', url], expect.objectContaining({ cwd: '/fixture' }));
  });
});
