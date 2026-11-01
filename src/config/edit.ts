// Changing a project's settings after it was added: sdlc.config.json (committed) and the personal overrides in the
// registry. Both go through the checks the CLI uses, so a bad value is refused with the same "path: problem" lines.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, type Json } from '../util.js';
import { NAME, readRegistry, writeRegistry, RegistryError, type ProjectEntry, type ProjectOverrides } from '../registry/projects.js';
import { fileErrors, personalErrors } from './settings.js';

/** A change to the settings file: objects merge, null removes a key, anything else replaces the value. */
export type SettingsPatch = Json;

export interface EditResult {
  ok: boolean;
  errors: string[];
  /** Hash of the file as it is now (of '' when there is none); pass it back as `expect` for the next edit. */
  hash: string;
}

export const hashOf = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** <base> with <patch> applied; keys the patch does not mention keep their value and their position. */
export function applyPatch(base: Json, patch: SettingsPatch): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isObject(v) && isObject(out[k])) out[k] = applyPatch(out[k], v);
    else if (isObject(v)) {
      // A new object whose every key was null has nothing to keep; an empty one is kept so the checks can name it.
      const made = applyPatch({}, v);
      if (Object.keys(made).length || !Object.keys(v).length) out[k] = made;
    } else out[k] = v;
  }
  // An object the patch emptied (every key set to null) goes too; one that was already empty is left for the checks to see.
  for (const k of Object.keys(out)) if (isObject(patch[k]) && isObject(base[k]) && Object.keys(base[k]).length && !Object.keys(out[k]).length) delete out[k];
  return out;
}

/** The indentation the file uses (2 spaces when it has none to copy). */
const indentOf = (text: string): string | number => {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? m[0] : 2;
};

/**
 * Applies <patch> to <root>/sdlc.config.json and saves it atomically, keeping the file's indentation. Nothing is written
 * when the result breaks the settings rules, or when `expect` is given and the file changed since it was read.
 */
export function editSettings(root: string, patch: SettingsPatch, expect?: string): EditResult {
  const file = path.join(root, CONFIG_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const hash = hashOf(text);
  if (expect !== undefined && expect !== hash) {
    return { ok: false, errors: [`${CONFIG_FILE} changed since you opened it; reload and apply the change again`], hash };
  }
  let current: Json = {};
  if (text) {
    try { current = JSON.parse(text); } catch (e) { return { ok: false, errors: [`${CONFIG_FILE}: not valid JSON (${(e as Error).message})`], hash }; }
  }
  const next = applyPatch(current, patch);
  const errors = fileErrors(next).map(e => `${CONFIG_FILE}: ${e}`);
  if (errors.length) return { ok: false, errors, hash };
  const out = `${JSON.stringify(next, null, indentOf(text))}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, out);
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    throw e;
  }
  return { ok: true, errors: [], hash: hashOf(out) };
}

/** Problems with personal overrides: worktreeBase must be text, maxParallel a whole number above 0, agent the agent settings. */
export function overrideErrors(o: Json): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'worktreeBase') { if (typeof v !== 'string' || !v) errors.push('worktreeBase: must be a non-empty string'); }
    else if (k === 'maxParallel') { if (!(Number.isInteger(v) && (v as number) > 0)) errors.push('maxParallel: must be a whole number above 0'); }
    else if (k === 'agent') { if (!isObject(v)) errors.push('agent: must be an object'); else errors.push(...personalErrors(v).map(e => (e.startsWith('agent') ? e : `agent.${e}`))); }
    else errors.push(`${k}: unknown override`);
  }
  return errors;
}

/**
 * Changes the personal overrides of the project called <name>: objects merge, null clears one (and the last clear drops
 * the key). Throws RegistryError for an unknown project.
 */
export function editOverrides(name: string, patch: Json, env: NodeJS.ProcessEnv = process.env): EditResult {
  const entries = readRegistry(env);
  const entry = entries.find(e => e.name === name);
  if (!entry || !NAME.test(name)) throw new RegistryError(`no project called "${name}"`);
  const merged = applyPatch((entry.overrides || {}) as Json, patch);
  const errors = overrideErrors(merged);
  if (errors.length) return { ok: false, errors, hash: '' };
  const next: ProjectEntry = { ...entry, overrides: merged as ProjectOverrides };
  if (!Object.keys(merged).length) Reflect.deleteProperty(next, 'overrides');
  writeRegistry(entries.map(e => (e === entry ? next : e)), env);
  return { ok: true, errors: [], hash: '' };
}
