// The tool calls of an agy round, read from the conversation agy stores for it (a sqlite file named in the result's
// conversation_id; read without -readonly, which cannot open it). Needs the sqlite3 command; without it, or without the file, the round has no steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TranscriptStep } from './types.js';

const TARGET_KEYS = ['Path', 'AbsolutePath', 'File', 'TargetFile', 'CommandLine', 'Command', 'Url', 'Query'];

/** The tool call and its target in the printable part of a stored step; null when the step is no tool call. */
export function parseStep(payload: string, error: string): TranscriptStep | null {
  const call = /([a-z]{2,}(?:_[a-z]+)+)[^{]{0,8}(\{"[A-Za-z]+":.*?\})/s.exec(payload);
  if (!call) return null;
  let target = '';
  try {
    const args = JSON.parse(call[2]);
    for (const k of TARGET_KEYS) if (typeof args[k] === 'string') { target = args[k]; break; }
  } catch { /* arguments cut off: no target */ }
  const denied = /permission check failed for (\S+) "([^"]+)"/.exec(error);
  if (denied) return { tool: denied[1], target: denied[2], status: 'denied' };
  return { tool: call[1], target, status: error.trim() ? 'error' : 'ok' };
}

export function agyTranscript(rawJson: unknown, home = os.homedir()): TranscriptStep[] {
  const id = rawJson && typeof rawJson === 'object' ? (rawJson as { conversation_id?: unknown }).conversation_id : null;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return [];
  const db = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`);
  if (!fs.existsSync(db)) return [];
  const r = spawnSync('sqlite3', ['-json', db, 'select idx, hex(step_payload) as p, hex(error_details) as e from steps where step_type = 132 order by idx'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  const text = (hex: unknown) => (typeof hex === 'string' ? Buffer.from(hex, 'hex').toString('latin1') : '');
  let rows: Array<{ p?: string; e?: string }> = [];
  try { rows = JSON.parse(r.stdout); } catch { return []; }
  return rows.map(row => parseStep(text(row.p), text(row.e))).filter((s): s is TranscriptStep => s !== null);
}
