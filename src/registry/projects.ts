import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDir } from '../configDir.js';

/** Personal settings for one project, kept out of its committed sdlc.config.json. */
export interface ProjectOverrides {
  worktreeBase?: string;
  maxParallel?: number;
  /** Personal agent, model and effort for the project (and per stage), above its sdlc.config.json. */
  agent?: Record<string, unknown>;
}

/** A registered project: a unique name for the top of its git work tree. */
export interface ProjectEntry {
  name: string;
  /** Absolute path of the git top level. */
  path: string;
  /** ISO time of the first registration. */
  addedAt: string;
  overrides?: ProjectOverrides;
}

/** The registry file cannot be read or does not hold a registry. */
export class RegistryError extends Error {}

export const REGISTRY_FILE = 'projects.json';
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where the registry lives: <configDir>/projects.json. */
export const registryFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(configDir(env), REGISTRY_FILE);

const entryProblem = (e: any, i: number): string | null => {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return `projects[${i}] is not an object`;
  if (typeof e.name !== 'string' || !NAME.test(e.name)) return `projects[${i}].name is not a valid name`;
  if (typeof e.path !== 'string' || !path.isAbsolute(e.path)) return `projects[${i}].path is not an absolute path`;
  if (typeof e.addedAt !== 'string') return `projects[${i}].addedAt is missing`;
  if (e.overrides !== undefined && (typeof e.overrides !== 'object' || e.overrides === null || Array.isArray(e.overrides))) return `projects[${i}].overrides is not an object`;
  return null;
};

/** The registered projects; [] when there is no registry yet. Throws RegistryError when the file is unreadable or corrupt. */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): ProjectEntry[] {
  const file = registryFile(env);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new RegistryError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let data: any;
  try { data = JSON.parse(text); } catch (e) {
    throw new RegistryError(`${file} is not valid JSON (${(e as Error).message}); fix it or delete it to start a new registry`);
  }
  const list = data && Array.isArray(data.projects) ? data.projects : null;
  if (!list) throw new RegistryError(`${file} has no "projects" list; fix it or delete it to start a new registry`);
  list.forEach((e: unknown, i: number) => {
    const p = entryProblem(e, i);
    if (p) throw new RegistryError(`${file}: ${p}; fix it or delete it to start a new registry`);
  });
  return list as ProjectEntry[];
}

/** Saves the registry atomically: a temporary file in the same folder, then a rename over the old one. */
export function writeRegistry(entries: ProjectEntry[], env: NodeJS.ProcessEnv = process.env): void {
  const file = registryFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, projects: sorted }, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    throw e;
  }
}

/** A registry name from a folder name: lowercase letters, digits and dashes. */
export function defaultName(dir: string): string {
  const n = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return n || 'project';
}

/** The top of the git work tree holding <dir>, or null when it is not in one (or git is missing). */
export function gitRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}

const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const samePath = (a: string, b: string): boolean => realpath(a) === realpath(b);

export const findByName = (entries: ProjectEntry[], name: string): ProjectEntry | undefined => entries.find(e => e.name === name);
export const findByPath = (entries: ProjectEntry[], dir: string): ProjectEntry | undefined => entries.find(e => samePath(e.path, dir));

/** The registered project whose folder holds <dir> (the deepest one when they nest). */
export function findContaining(entries: ProjectEntry[], dir: string): ProjectEntry | undefined {
  const at = realpath(dir);
  return entries
    .filter(e => { const p = realpath(e.path); return at === p || at.startsWith(p.endsWith(path.sep) ? p : p + path.sep); })
    .sort((a, b) => realpath(b.path).length - realpath(a.path).length)[0];
}

/** A name not used by another project: <base>, else <base>-2, <base>-3... */
export function freeName(entries: ProjectEntry[], base: string, forPath: string): string {
  const taken = (n: string) => entries.some(e => e.name === n && !samePath(e.path, forPath));
  if (!taken(base)) return base;
  let i = 2;
  while (taken(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export interface AddInput {
  name: string;
  path: string;
  overrides?: ProjectOverrides;
  now?: Date;
}

/**
 * <entries> with the project added, or updated when its path is already registered (it keeps addedAt, and its overrides
 * unless new ones are given). Throws RegistryError for a bad name or one another project uses.
 */
export function withProject(entries: ProjectEntry[], input: AddInput): { entries: ProjectEntry[]; entry: ProjectEntry; updated: boolean } {
  if (!NAME.test(input.name)) throw new RegistryError(`"${input.name}" is not a valid name: use lowercase letters, digits and dashes`);
  const clash = entries.find(e => e.name === input.name && !samePath(e.path, input.path));
  if (clash) throw new RegistryError(`the name "${input.name}" is already used by ${clash.path}; pick another with --name`);
  const old = findByPath(entries, input.path);
  const overrides = { ...(old?.overrides || {}), ...(input.overrides || {}) };
  const entry: ProjectEntry = {
    name: input.name, path: path.resolve(input.path), addedAt: old?.addedAt || (input.now || new Date()).toISOString(),
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
  return { entries: [...entries.filter(e => e !== old), entry], entry, updated: Boolean(old) };
}

/** <entries> without the project called <name>; throws RegistryError when there is none. */
export function withoutProject(entries: ProjectEntry[], name: string): ProjectEntry[] {
  if (!findByName(entries, name)) {
    throw new RegistryError(`no project "${name}"${entries.length ? ` (registered: ${entries.map(e => e.name).join(', ')})` : ' (none are registered)'}`);
  }
  return entries.filter(e => e.name !== name);
}

/**
 * The project folder a command works on. <arg> is a registered name, else a path (its git top level, or the folder
 * itself). Without <arg>: the registered project holding <cwd>, else the git top level of <cwd>, else <cwd>.
 * Throws RegistryError when <arg> is neither a name nor an existing folder, or the registry is corrupt.
 */
export function projectDir(arg: string | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const entries = readRegistry(env);
  if (arg) {
    const named = findByName(entries, arg);
    if (named) return named.path;
    const dir = path.resolve(cwd, arg);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return gitRoot(dir, env) || dir;
    throw new RegistryError(`"${arg}" is not a registered project or a folder`
      + `${entries.length ? ` (registered: ${entries.map(e => e.name).join(', ')})` : ''}`);
  }
  const inside = findContaining(entries, cwd);
  if (inside) return inside.path;
  return gitRoot(cwd, env) || path.resolve(cwd);
}
