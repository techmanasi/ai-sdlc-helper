import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR, exists, type Json } from '../util.js';
import { onPath as found } from '../shell.js';

/**
 * Code search: a code indexer (graft, graphify, or one the project declares) or Grep/Glob. An indexer is used when its
 * command is on PATH and its index exists in the project; one is recommended, none is required. agent.codeSearch picks
 * one by name, "auto" (the first available, in agent.codeSearchOrder) or "none"; agent.codeIndexers adds indexers or
 * changes a built-in one field by field.
 */
export interface CodeIndexer {
  name: string;
  command?: string;
  index?: string;
  tools: string[];
  commands: string[];
  guide?: string;
  guideFile?: string;
  setup?: string;
  /** How to build the index once the command is installed. */
  build?: string;
  /** The command line that builds the index headlessly, program and arguments, no shell syntax. */
  buildCommand?: string;
}

export const CODE_INDEXERS: Record<string, Omit<CodeIndexer, 'name'>> = {
  graft: {
    command: 'graft', index: 'graft', tools: ['mcp__graft'], commands: ['graft'],
    setup: 'npm install -g @nanonets/graft, then graft build', build: 'graft build',
    buildCommand: 'graft build',
  },
  graphify: {
    command: 'graphify', index: 'graphify-out/graph.json', tools: [], commands: ['graphify'],
    setup: 'uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code',
    build: 'build the graph with /graphify . in Claude Code',
  },
};
export const INDEXER_SCHEMA = { name: 'string', command: 'string', index: 'string', tools: 'string[]', commands: 'string[]', guide: 'string', guideFile: 'string', setup: 'string', build: 'string', buildCommand: 'string' };
export const SEARCH_SETTINGS = ['auto', 'none'];
export const PARTS_DIR = path.join(ASSETS_DIR, 'prompts', 'parts');

const PROGRAM = /^[\w.@+-]+$/;
const onPath = (cmd: string, env: NodeJS.ProcessEnv) => PROGRAM.test(cmd) && found(cmd, { env });

/** The built-in indexers merged with the project's agent.codeIndexers. */
export function codeIndexers(file: Json = {}): Record<string, CodeIndexer> {
  const own: Json = (file.agent && file.agent.codeIndexers) || {};
  const out: Record<string, CodeIndexer> = {};
  for (const name of [...Object.keys(CODE_INDEXERS), ...Object.keys(own)]) {
    const merged: Json = { ...(CODE_INDEXERS[name] || {}), ...(own[name] || {}) };
    out[name] = { ...merged, name, tools: merged.tools || [], commands: merged.commands || [] } as CodeIndexer;
  }
  return out;
}

/** What is wrong with the code search settings (beyond their types): unknown names, incomplete indexers. */
export function codeSearchErrors(file: Json = {}): string[] {
  const errors: string[] = [];
  const agent: Json = file.agent || {};
  const all = codeIndexers(file);
  for (const [name, ix] of Object.entries<Json>(agent.codeIndexers || {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`agent.codeIndexers.${name}: names use lowercase letters, digits and dashes`);
    if (SEARCH_SETTINGS.includes(name)) errors.push(`agent.codeIndexers.${name}: "${name}" is reserved`);
    if (!CODE_INDEXERS[name] && !ix.command) errors.push(`agent.codeIndexers.${name}: needs "command" (the program that must be on PATH)`);
    if (!CODE_INDEXERS[name] && !ix.guide && !ix.guideFile) errors.push(`agent.codeIndexers.${name}: needs "guide" or "guideFile" (how the agents should search with it)`);
    if (ix.command && !PROGRAM.test(ix.command)) errors.push(`agent.codeIndexers.${name}.command: a program name, not a command line`);
    if (ix.buildCommand !== undefined) {
      const words = typeof ix.buildCommand === 'string' ? ix.buildCommand.trim().split(/\s+/).filter(Boolean) : [];
      if (!words.length || !PROGRAM.test(words[0]) || !words.every(w => /^[\w.@+\/=:-]+$/.test(w))) {
        errors.push(`agent.codeIndexers.${name}.buildCommand: a program and its arguments, no shell syntax`);
      }
    }
  }
  if (agent.codeSearch && !SEARCH_SETTINGS.includes(agent.codeSearch) && !all[agent.codeSearch]) {
    errors.push(`agent.codeSearch: "${agent.codeSearch}" is not a code indexer (use auto, none, ${Object.keys(all).join(', ')})`);
  }
  for (const n of agent.codeSearchOrder || []) if (!all[n]) errors.push(`agent.codeSearchOrder: "${n}" is not a code indexer`);
  return errors;
}

/** Why <ix> cannot be used in <root>, or null when it can. */
export function unavailable(ix: CodeIndexer, root: string, env: NodeJS.ProcessEnv): string | null {
  if (!ix.command || !onPath(ix.command, env)) return `${ix.name} is not installed (no ${ix.command || '?'} command)`;
  if (ix.index && !exists(path.join(root, ix.index))) return `the project has no ${ix.name} index (${ix.index})`;
  return null;
}

export interface CodeSearch {
  /** The indexer's name, or "none" for Grep and Glob. */
  codeSearch: string;
  indexer: CodeIndexer | null;
  warning: string | null;
}

/**
 * The code search for the project. Never an error: an indexer that cannot be used falls back to Grep and Glob with a
 * warning that says how to set one up.
 */
export function codeSearchFor(root: string, file: Json = {}, env: NodeJS.ProcessEnv = process.env): CodeSearch {
  const setting: string = (file.agent && file.agent.codeSearch) || 'auto';
  const none = (warning: string | null): CodeSearch => ({ codeSearch: 'none', indexer: null, warning });
  if (setting === 'none') return none(null);
  const all = codeIndexers(file);
  if (setting !== 'auto') {
    const ix = all[setting];
    if (!ix) return none(`agent.codeSearch names "${setting}", which is not a code indexer; code search uses Grep and Glob`);
    const why = unavailable(ix, root, env);
    return why ? none(`agent.codeSearch is "${setting}" but ${why}; code search uses Grep and Glob. To set it up: ${ix.setup || 'see its documentation'}`)
      : { codeSearch: setting, indexer: ix, warning: null };
  }
  for (const name of (file.agent && file.agent.codeSearchOrder) || Object.keys(all)) {
    const ix = all[name];
    if (ix && !unavailable(ix, root, env)) return { codeSearch: name, indexer: ix, warning: null };
  }
  // An indexer that is installed only needs its index built; the others need installing too.
  const offers = Object.values(all).map(ix => (ix.build && ix.command && onPath(ix.command, env)
    ? `${ix.name} (installed; build its index: ${ix.build})` : ix.setup ? `${ix.name} (${ix.setup})` : '')).filter(Boolean);
  return none(`no code indexer is available; code search uses Grep and Glob.${offers.length ? ` A code indexer is recommended: ${offers.join(', or ')}` : ''}`);
}

/**
 * The code-search text for skills and prompts: the indexer's "guide", its "guideFile" (from the project root), or
 * parts/code-search.<name>.md; Grep and Glob use parts/code-search.md.
 */
export function codeSearchGuide(search: CodeSearch, root: string, partsDir = PARTS_DIR): string {
  const ix = search.indexer;
  if (ix && ix.guide) return ix.guide.trim();
  if (ix && ix.guideFile) return fs.readFileSync(path.resolve(root, ix.guideFile), 'utf8').trim();
  const own = ix ? path.join(partsDir, `code-search.${ix.name}.md`) : null;
  return fs.readFileSync(own && exists(own) ? own : path.join(partsDir, 'code-search.md'), 'utf8').trim();
}

/** Splits an indexer's buildCommand into a file and argument list, or null when absent or empty. */
export function codeBuildArgv(ix: CodeIndexer): { file: string; args: string[] } | null {
  if (!ix.buildCommand) return null;
  const parts = ix.buildCommand.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { file: parts[0], args: parts.slice(1) };
}

export interface CodeIndexerStatus {
  name: string;
  command?: string;
  index?: string;
  installed: boolean;
  indexed: boolean;
  setup?: string;
  build?: string;
  canBuild: boolean;
}

export interface CodeSearchView {
  setting: string;
  effective: string;
  warning: string | null;
  indexers: CodeIndexerStatus[];
}

/** Reports installation on PATH, index presence, and effective search engine for each indexer. */
export function codeSearchStatus(root: string, file: Json = {}, env: NodeJS.ProcessEnv = process.env): CodeSearchView {
  const setting: string = (file.agent && file.agent.codeSearch) || 'auto';
  const resolved = codeSearchFor(root, file, env);
  const all = codeIndexers(file);
  const indexers: CodeIndexerStatus[] = Object.values(all).map(ix => {
    const installed = Boolean(ix.command && onPath(ix.command, env));
    const indexed = ix.index ? exists(path.join(root, ix.index)) : installed;
    const canBuild = codeBuildArgv(ix) !== null;
    const item: CodeIndexerStatus = {
      name: ix.name,
      installed,
      indexed,
      canBuild,
    };
    if (ix.command !== undefined) item.command = ix.command;
    if (ix.index !== undefined) item.index = ix.index;
    if (ix.setup !== undefined) item.setup = ix.setup;
    if (ix.build !== undefined) item.build = ix.build;
    return item;
  });
  return {
    setting,
    effective: resolved.codeSearch,
    warning: resolved.warning,
    indexers,
  };
}
