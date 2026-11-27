// tools/UI-automation/sdlc-ui.js reads and drives the web UI by its class names, ids and aria labels. This loads the
// script as the browser does (a plain script that sets globalThis.sdlcUI) and checks every hook in its SELECTORS still
// appears in the UI's markup (web/ui/src), so a UI change that breaks the tool fails here, not in the next live run.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const tool = path.join(root, 'tools/UI-automation/sdlc-ui.js');
const srcDir = path.join(root, 'web/ui/src');

interface Api { VERSION: number; SELECTORS: Record<string, string>; help(): string }

function load(): { api: Api; result: unknown; stored: Map<string, string> } {
  const stored = new Map<string, string>();
  const sandbox: Record<string, unknown> = { localStorage: { setItem: (k: string, v: string) => { stored.set(k, v); } } };
  sandbox.globalThis = sandbox;
  const result = vm.runInNewContext(fs.readFileSync(tool, 'utf8'), sandbox, { filename: tool });
  return { api: sandbox.sdlcUI as Api, result, stored };
}

/** The markup: every .tsx/.ts file under web/ui/src (styles.css is left out: a class only styled there is not on the page). */
function markup(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(srcDir);
  return out.join('\n');
}

/** The class names, ids and aria-labels one selector depends on. */
function hooks(sel: string): { classes: string[]; ids: string[]; labels: string[] } {
  const bare = sel.replace(/\[[^\]]*\]/g, ' ');
  return {
    classes: [...bare.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]),
    ids: [...bare.matchAll(/#([A-Za-z][\w-]*)/g)].map(m => m[1]),
    labels: [...sel.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]),
  };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('tools/UI-automation/sdlc-ui.js', () => {
  test('loads as a plain script: sets globalThis.sdlcUI, keeps itself for a reload, and lists its functions', () => {
    const { api, result, stored } = load();
    expect(api.VERSION).toBeGreaterThan(0);
    expect(String(result)).toMatch(/^sdlcUI v\d+ loaded/);
    expect(api.help()).toContain('snapshot');
    for (const f of ['board', 'run', 'stages', 'questions', 'answer', 'setEnv', 'click', 'newItem']) expect(api.help()).toContain(f);
    // the kept copy runs on its own the same way
    const again: Record<string, unknown> = { localStorage: { setItem() {} } };
    again.globalThis = again;
    vm.runInNewContext(stored.get('sdlc-ui-tool') ?? '', again);
    expect((again.sdlcUI as Api).help()).toBe(api.help());
  });

  test('every class, id and aria-label in SELECTORS is still in the UI markup (web/ui/src)', () => {
    const { api } = load();
    const src = markup();
    const missing: string[] = [];
    for (const [name, sel] of Object.entries(api.SELECTORS)) {
      // segOn is a bare class name (classList.contains), not a selector
      const h = /^[\w-]+$/.test(sel) && !/^[a-z]+$/.test(sel) ? { classes: [sel], ids: [], labels: [] } : hooks(sel);
      for (const c of h.classes) {
        // a class is written as a word in class="..." / class={`...`}; `tile-${s.state}` makes every tile-<state>
        if (!new RegExp(`(^|[\\s"'\`{])${esc(c)}($|[\\s"'\`}])`).test(src)) missing.push(`${name}: class ${c}`);
      }
      for (const id of h.ids) if (!new RegExp(`id=["{\`']+${esc(id)}["}\`']`).test(src)) missing.push(`${name}: id ${id}`);
      for (const l of h.labels) if (!src.includes(`aria-label="${l}"`)) missing.push(`${name}: aria-label ${l}`);
    }
    expect(missing).toEqual([]);
  });

  test('exposes code search setup dialog, indexer and build feedback hooks', () => {
    const { api } = load();
    const selectors = Object.entries(api.SELECTORS);
    expect(selectors.some(([, value]) => value.includes('aria-label="Code Search Setup"'))).toBe(true);
    expect(selectors.some(([name]) => /indexer.*card|card.*indexer/i.test(name))).toBe(true);
    expect(selectors.some(([name]) => /indexer.*(status|badge)|(status|badge).*indexer/i.test(name))).toBe(true);
    expect(selectors.some(([name]) => /indexer.*action|action.*indexer/i.test(name))).toBe(true);
    expect(selectors.some(([name]) => /build.*(output|feedback|error)|(output|feedback|error).*build/i.test(name))).toBe(true);
    expect(api.help()).toMatch(/code.?search|indexer/i);
  });

  test('exposes the Default editor dialog, row and custom command hooks', () => {
    const { api } = load();
    const selectors = Object.entries(api.SELECTORS);
    expect(selectors.some(([, value]) => value.includes('aria-label="Default editor"'))).toBe(true);
    expect(selectors.some(([name]) => /editor.*row|row.*editor/i.test(name))).toBe(true);
    expect(selectors.some(([, value]) => /#editor-custom/.test(value))).toBe(true);
    expect(api.help()).toMatch(/setEditor/);
    expect(api.help()).toMatch(/editorDialog/);
  });

  test('the drift check sees a selector that is not in the markup', () => {
    const src = markup();
    expect(new RegExp(`(^|[\\s"'\`{])${esc('no-such-class-xyz')}($|[\\s"'\`}])`).test(src)).toBe(false);
    expect(hooks('.a .b-c #d [aria-label="Name"] input[type="x"]')).toEqual({ classes: ['a', 'b-c'], ids: ['d'], labels: ['Name'] });
  });
});
