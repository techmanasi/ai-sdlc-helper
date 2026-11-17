import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { startServer } from '../server/index.js';

describe('invalid saved review loop limit', () => {
  it('exposes the stored key so a settings save can clear it', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-limit-')));
    const file = path.join(repo, 'sdlc.config.json');
    fs.writeFileSync(file, JSON.stringify({ suites: [{ dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], review: { maxLoops: -1 } }));
    const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    expect(git.status).toBe(0);
    const env = { ...process.env, AI_SDLC_HELPER_CONFIG_DIR: path.join(repo, 'config') };
    const server = await startServer({ port: 0, cwd: repo, env });
    try {
      const url = `http://127.0.0.1:${server.port}/api/projects/${path.basename(repo).toLowerCase()}/settings`;
      const headers = { 'x-sdlc-token': server.token, 'content-type': 'application/json' };
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      const view = await response.json() as { fileReview: { maxLoops?: unknown }; hash: string };
      expect(view.fileReview).toHaveProperty('maxLoops');
      const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ patch: { review: { maxLoops: null } }, hash: view.hash }) });
      expect((await saved.json() as { ok: boolean }).ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).review?.maxLoops).toBeUndefined();
    } finally {
      await server.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hookIndex++;
    return [index < hookValues.length ? hookValues[index] : initial, (value: unknown) => { hookValues[index] = value; }];
  },
  useEffect: vi.fn(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock('../ui/src/ui', () => ({ Cli: vi.fn(), ErrorBox: vi.fn(), useApp: () => ({ project: 'shop', toast: vi.fn(), go: vi.fn() }) }));

const hookValues: unknown[] = [];
let hookIndex = 0;

type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  const node = value as Node;
  return visibleText(node.props.children);
}

async function projectForm(fileReview: Record<string, unknown>, loops: string) {
  const componentPath = '../ui/src/Projects.js';
  const { Projects } = await import(componentPath);
  hookValues.splice(0, hookValues.length, '', '', '', '', false, 'shop', 0);
  hookIndex = 0;
  const page = Projects({ projects: [], reload: vi.fn() });
  const edit = nodes(page).find(n => typeof n.type === 'function' && (n.type as (...args: never[]) => unknown).name === 'EditSetup');
  expect(edit).toBeDefined();
  const data = {
    fileReview, defaults: { reviewMaxLoops: 2 }, fileAgent: {}, personalAgent: {}, stages: [],
    config: {}, overrides: {}, sources: { stages: {} }, files: { project: 'config', personal: 'personal' },
    models: {}, harnesses: ['claude'], efforts: [], stageDefaults: {}, registered: false, hash: 'hash',
  };
  hookValues.splice(0, hookValues.length, data, 'project', { harness: 'claude', model: '', effort: '' }, {}, '', '', '', 'scoped', loops, '', [], '', false);
  const render = () => {
    hookIndex = 0;
    return (edit!.type as (props: Record<string, unknown>) => Node)(edit!.props);
  };
  return { form: render(), render }; 
}

describe('project review limit form', () => {
  it('shows the configured current value and the default while the input is filled', async () => {
    const { form } = await projectForm({ maxLoops: 3 }, '3');
    const input = nodes(form).find(n => n.props.id === 'loops-shop');
    expect(input?.props.value).toBe('3');
    const text = visibleText(form);
    expect(text).toMatch(/Current:\s*3/);
    expect(text).toMatch(/default\D*2/i);
  });
});



describe('project review limit validation', () => {
  it('keeps invalid input and displays the server refusal beside the field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, errors: ['sdlc.config.json: review.maxLoops: must be a whole number, 0 or more'] }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { form, render } = await projectForm({}, '');
      const input = nodes(form).find(n => n.props.id === 'loops-shop')!;
      input.props.onInput({ target: { value: 'abc' } });
      const changed = render();
      const submit = nodes(changed).find(n => n.type === 'form')!;
      await submit.props.onSubmit({ preventDefault: vi.fn() });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).patch.review.maxLoops).toBe('abc');
      const result = render();
      const row = nodes(result).find(n => n.type === 'div' && Array.isArray(n.props.children) && n.props.children.some((child: Node | null) => child?.props?.id === 'loops-shop'))!;
      expect(nodes(row).find(n => n.props.id === 'loops-shop')?.props.value).toBe('abc');
      expect(visibleText(row)).toContain('must be a whole number, 0 or more');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
