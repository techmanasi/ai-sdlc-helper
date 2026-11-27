// The default editor ("Open in editor"): the argv each choice maps to per platform, the custom command's rules
// ({path} becomes one argument, never a string a shell would read), the registry round-trip of the choice, and the
// dialog's save decisions (web/ui/src/editorDialog.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_EDITOR, EDITOR_IDS, editorArgv, editorChoices, editorName, editorSettingErrors, normalizeEditor, splitWords,
  systemEditorCmd, validateCustomEditor,
} from '../src/config/editor.js';
import { readEditorSetting, readRegistry, registryFile, writeEditorSetting, writeRegistry, RegistryError, type ProjectEntry } from '../src/registry/projects.js';
import { draftProblem, editorPatch } from '../web/ui/src/editorDialog.js';
import { tmp } from './helpers.js';

const env = (): NodeJS.ProcessEnv => ({ AI_SDLC_HELPER_CONFIG_DIR: tmp('ai-sdlc-cfg-') });
const FOLDER = '/Volumes/Work/My Project/x';

describe('each editor maps to its argv, per platform', () => {
  test('the four named editors run their command with the folder as the only argument', () => {
    for (const [id, cmd] of [['vscode', 'code'], ['cursor', 'cursor'], ['zed', 'zed'], ['idea', 'idea']] as const) {
      expect(editorArgv(id, undefined, FOLDER, 'darwin')).toEqual({ cmd, args: [FOLDER] });
      expect(editorArgv(id, undefined, FOLDER, 'win32')).toEqual({ cmd, args: [FOLDER] }); // the same everywhere
    }
  });

  test('the system default is open on darwin, xdg-open on linux, explorer on win32 — never cmd /c start', () => {
    expect(systemEditorCmd('darwin')).toBe('open');
    expect(systemEditorCmd('linux')).toBe('xdg-open');
    expect(systemEditorCmd('win32')).toBe('explorer');
    expect(editorArgv('system', undefined, FOLDER, 'darwin')).toEqual({ cmd: 'open', args: [FOLDER] });
    expect(editorArgv('system', undefined, FOLDER, 'linux')).toEqual({ cmd: 'xdg-open', args: [FOLDER] });
    const win = editorArgv('system', undefined, 'C:\\My Folder\\x', 'win32');
    expect(win).toEqual({ cmd: 'explorer', args: ['C:\\My Folder\\x'] });
    expect(JSON.stringify(win)).not.toContain('cmd /c'); // never cmd /c start ""
    expect(JSON.stringify(win)).not.toContain('start');
  });

  test('an unknown choice (a registry hand-edited to something else) opens the default, VS Code', () => {
    expect(DEFAULT_EDITOR).toBe('vscode');
    expect(editorArgv('emacs', undefined, FOLDER, 'darwin')).toEqual({ cmd: 'code', args: [FOLDER] });
    expect(normalizeEditor({ choice: 'emacs' })).toEqual({ choice: 'vscode' });
    expect(normalizeEditor(undefined)).toEqual({ choice: 'vscode' });
    expect(normalizeEditor({ choice: 'zed', custom: 'zed {path}' })).toEqual({ choice: 'zed', custom: 'zed {path}' });
  });

  test('the dialog offers the six editors, in the design order, each with the command it shows', () => {
    const rows = editorChoices('darwin');
    expect(rows.map(r => r.id)).toEqual([...EDITOR_IDS]);
    expect(rows.map(r => r.name)).toEqual(['VS Code', 'Cursor', 'Zed', 'IntelliJ IDEA', 'System default', 'Custom command']);
    expect(rows.find(r => r.id === 'system')!.cmd).toBe('open');
    expect(editorChoices('linux').find(r => r.id === 'system')!.cmd).toBe('xdg-open');
    expect(editorChoices('win32').find(r => r.id === 'system')!.cmd).toBe('explorer');
    expect(editorName('zed')).toBe('Zed');
    expect(editorName('nope')).toBe('VS Code');
  });
});

describe('a custom command: words, {path} as ONE argument, no shell', () => {
  test('{path} becomes one argument — quoted or not, spaces and all; nothing is interpolated into a string', () => {
    expect(editorArgv('custom', 'subl {path}', FOLDER, 'darwin')).toEqual({ cmd: 'subl', args: [FOLDER] });
    expect(editorArgv('custom', 'subl "{path}"', FOLDER, 'darwin')).toEqual({ cmd: 'subl', args: [FOLDER] });
    const spaced = editorArgv('custom', 'code --wait {path} --new-window', FOLDER, 'linux');
    expect(spaced).toEqual({ cmd: 'code', args: ['--wait', FOLDER, '--new-window'] });
    // a folder whose name holds shell-looking text is still one literal argument
    const hostile = '/tmp/a b;rm -rf ~';
    expect(editorArgv('custom', 'subl {path}', hostile, 'darwin')).toEqual({ cmd: 'subl', args: [hostile] });
  });

  test('the command line is split on whitespace, with "double quoted" words kept together', () => {
    expect(splitWords('  subl   {path}  ')).toEqual(['subl', '{path}']);
    expect(splitWords('"My Editor" {path}')).toEqual(['My Editor', '{path}']);
    expect(splitWords('code --flag "a value" {path}')).toEqual(['code', '--flag', 'a value', '{path}']);
    expect(editorArgv('custom', '"My Editor" {path}', FOLDER, 'darwin')).toEqual({ cmd: 'My Editor', args: [FOLDER] });
  });

  test('a word that only contains {path} is left alone; only the whole word is replaced', () => {
    expect(editorArgv('custom', 'code --folder={path}', FOLDER, 'darwin')).toEqual({ cmd: 'code', args: ['--folder={path}'] });
  });
});

describe('validateCustomEditor: each way a custom command is refused', () => {
  test('empty', () => {
    expect(validateCustomEditor('')).toMatch(/the command is empty/);
    expect(validateCustomEditor('   ')).toMatch(/the command is empty/);
    expect(validateCustomEditor(undefined)).toMatch(/the command is empty/);
  });

  test('no {path}, or {path} only inside another word', () => {
    expect(validateCustomEditor('subl .')).toMatch(/must contain \{path\} as its own word/);
    expect(validateCustomEditor('code --folder={path}')).toMatch(/must contain \{path\} as its own word/);
    expect(validateCustomEditor('code {path2}')).toMatch(/must contain \{path\} as its own word/);
  });

  test('shell metacharacters, each one', () => {
    for (const bad of ['subl {path}; x', 'subl {path} | x', 'subl {path} & x', 'subl $(pwd) {path}', 'subl `pwd` {path}', 'subl {path} > out', 'subl < in {path}']) {
      expect(validateCustomEditor(bad)).toMatch(/must not contain ; \| & \$ ` < or >/);
    }
  });

  test('newlines', () => {
    expect(validateCustomEditor('subl {path}\nrm -rf /')).toMatch(/one line/);
    expect(validateCustomEditor('subl {path}\rx')).toMatch(/one line/);
  });

  test('a good command passes, quoted or not', () => {
    expect(validateCustomEditor('subl {path}')).toBeNull();
    expect(validateCustomEditor('subl "{path}"')).toBeNull();
    expect(validateCustomEditor('"My Editor" --wait {path}')).toBeNull();
  });

  test('the saved setting is checked the same way: the choice must be one of the six', () => {
    expect(editorSettingErrors('vscode', undefined)).toEqual([]);
    expect(editorSettingErrors('custom', 'subl {path}')).toEqual([]);
    expect(editorSettingErrors('zed', 'subl {path}')).toEqual([]); // a remembered command may be kept
    expect(editorSettingErrors('emacs', undefined)).toEqual([expect.stringMatching(/must be one of vscode, cursor, zed, idea, system, custom/)]);
    expect(editorSettingErrors(undefined, undefined)).toEqual([expect.stringMatching(/must be one of/)]);
    expect(editorSettingErrors('custom', undefined)).toEqual([expect.stringMatching(/editor\.custom: the command is empty/)]);
    expect(editorSettingErrors('custom', 'subl .')).toEqual([expect.stringMatching(/editor\.custom: .*own word/)]);
    expect(editorSettingErrors('vscode', 'subl .')).toEqual([expect.stringMatching(/editor\.custom: .*own word/)]);
    expect(editorSettingErrors('vscode', 42)).toEqual(['editor.custom: must be text']);
  });
});

describe('the editor setting in the registry: a machine-wide round-trip', () => {
  const entry = (name: string): ProjectEntry => ({ name, path: `/p/${name}`, addedAt: '2026-11-28T00:00:00.000Z' });

  test('nothing saved reads as nothing; what is written reads back, with the projects beside it', () => {
    const e = env();
    expect(readEditorSetting(e)).toBeUndefined();
    writeRegistry([entry('shop')], e);
    writeEditorSetting({ choice: 'custom', custom: '"My Editor" {path}' }, e);
    expect(readEditorSetting(e)).toEqual({ choice: 'custom', custom: '"My Editor" {path}' });
    expect(readRegistry(e).map(p => p.name)).toEqual(['shop']);
    const saved = JSON.parse(fs.readFileSync(registryFile(e), 'utf8'));
    expect(saved.editor).toEqual({ choice: 'custom', custom: '"My Editor" {path}' });
    expect(saved.version).toBe(1);
  });

  test('a registry write that knows nothing about the editor keeps it (adding a project does not drop it)', () => {
    const e = env();
    writeEditorSetting({ choice: 'zed' }, e);
    writeRegistry([entry('shop'), entry('app')], e);
    expect(readEditorSetting(e)).toEqual({ choice: 'zed' });
    expect(readRegistry(e).map(p => p.name)).toEqual(['app', 'shop']);
  });

  test('saving nothing again removes the setting; the projects stay', () => {
    const e = env();
    writeRegistry([entry('shop')], e);
    writeEditorSetting({ choice: 'cursor' }, e);
    writeEditorSetting(undefined, e);
    expect(readEditorSetting(e)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(registryFile(e), 'utf8')).editor).toBeUndefined();
    expect(readRegistry(e).map(p => p.name)).toEqual(['shop']);
  });

  test('a hand-edited setting that is not a valid shape reads as nothing; a corrupt registry is the known error', () => {
    const e = env();
    writeRegistry([entry('shop')], e);
    const raw = JSON.parse(fs.readFileSync(registryFile(e), 'utf8'));
    fs.writeFileSync(registryFile(e), JSON.stringify({ ...raw, editor: 'zed' }));
    expect(readEditorSetting(e)).toBeUndefined();
    fs.writeFileSync(registryFile(e), '{ not json');
    expect(() => readEditorSetting(e)).toThrow(RegistryError);
    expect(() => readEditorSetting(e)).toThrow(/is not valid JSON/);
    expect(() => writeEditorSetting({ choice: 'zed' }, e)).toThrow(/is not valid JSON/);
  });

  test('what the server opens is what the registry saved', () => {
    const e = env();
    writeEditorSetting({ choice: 'custom', custom: 'subl "{path}"' }, e);
    const setting = normalizeEditor(readEditorSetting(e));
    expect(setting).toEqual({ choice: 'custom', custom: 'subl "{path}"' });
    expect(editorArgv(setting.choice, setting.custom, FOLDER, 'darwin')).toEqual({ cmd: 'subl', args: [FOLDER] });
  });
});

describe('the dialog\'s decisions (web/ui/src/editorDialog.ts)', () => {
  test('the inline error: only the custom choice needs a command, and each refusal names its problem', () => {
    expect(draftProblem({ choice: 'vscode', custom: '' })).toBe('');
    expect(draftProblem({ choice: 'custom', custom: 'subl {path}' })).toBe('');
    expect(draftProblem({ choice: 'custom', custom: '' })).toMatch(/the command is empty/);
    expect(draftProblem({ choice: 'custom', custom: 'subl .' })).toMatch(/own word/);
    expect(draftProblem({ choice: 'custom', custom: 'subl {path} | x' })).toMatch(/must not contain/);
    expect(draftProblem({ choice: 'custom', custom: 'subl {path}\nx' })).toMatch(/one line/);
  });

  test('the save body: the choice, and the custom command only when it is valid text', () => {
    expect(editorPatch({ choice: 'custom', custom: '  subl {path} ' })).toEqual({ choice: 'custom', custom: 'subl {path}' });
    expect(editorPatch({ choice: 'zed', custom: 'subl {path}' })).toEqual({ choice: 'zed', custom: 'subl {path}' }); // kept for switching back
    expect(editorPatch({ choice: 'zed', custom: 'junk' })).toEqual({ choice: 'zed' }); // junk under another editor is dropped
    expect(editorPatch({ choice: 'system', custom: '' })).toEqual({ choice: 'system' });
  });
});

describe('the editor module stays browser-pure', () => {
  test('the file imports nothing, so the web UI can share it', () => {
    const file = fs.readFileSync(path.resolve('src/config/editor.ts'), 'utf8');
    expect(file).not.toMatch(/^import /m);
    expect(file).not.toContain('node:');
  });
});
