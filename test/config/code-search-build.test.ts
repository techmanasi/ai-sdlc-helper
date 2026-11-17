import { describe, it, expect } from 'vitest';
import * as search from '../../src/config/codeSearch.js';

type Indexer = { name: string; command: string; index: string; build?: string; setup: string };
const runnable = (search as unknown as { runnableBuild: (ix: Indexer) => { program: string; args: string[] } | null }).runnableBuild;
const indexer = (build: string): Indexer => ({ name: 'graft', command: 'graft', index: 'graft', setup: '', build });

describe('runnable indexer builds', () => {
  it('splits a command and its arguments without a shell', () => {
    expect(runnable(indexer('graft build --fast'))).toEqual({ program: 'graft', args: ['build', '--fast'] });
  });

  it.each(['', '   ', 'build the graph with /graphify .', 'other build', 'graft build; rm', 'graft build & x', 'graft build | x', 'graft > x', 'graft < x', 'graft $HOME', 'graft `id`', 'graft (x)', 'graft "x"', "graft 'x'"])(
    'rejects non-runnable build %j', build => {
      expect(runnable(indexer(build))).toBeNull();
    },
  );
});
