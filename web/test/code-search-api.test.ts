import { afterEach, describe, it, expect, vi } from 'vitest';

// Load the browser entry at runtime in the server test project (which has no DOM library).
const clientModule = '../ui/src/api';
const { api, ApiError } = await import(clientModule);
const project = 'app one/two';
const route = '/api/projects/app%20one%2Ftwo/code-search';

function respond(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('code search browser client', () => {
  it('reads the inspection for an encoded project name', async () => {
    const status = { setting: 'auto', current: 'none', indexers: [] };
    const fetch = respond(status);
    expect(await api.codeSearch(project)).toEqual(status);
    expect(fetch).toHaveBeenCalledWith(route, expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it.each([true, false])('posts build=%s and returns the refreshed checks', async build => {
    const body = { indexer: 'graft', build };
    const result = { ok: true, codeSearch: 'graft', checks: [{ name: 'code indexer', ok: true }] };
    const fetch = respond(result);
    expect(await api.setupCodeSearch(project, body)).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(route + '/setup', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });

  it('retains build diagnostics on the ApiError from a rejected setup', async () => {
    const failure = { ok: false, error: 'builder exited with code 9', output: 'scanning\ninvalid index' };
    respond(failure, 400);
    const request = api.setupCodeSearch(project, { indexer: 'graft', build: true });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ message: failure.error, output: failure.output });
  });
});
