// The server's guard and plumbing: who may talk to it (the token, the Host and Origin checks), JSON in and out, and the
// static files of the built app.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import type http from 'node:http';

export const COOKIE = 'sdlc_t';
export const TOKEN_HEADER = 'x-sdlc-token';
const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The hosts a request may name: this server's port on the loopback names only (a rebound DNS name is refused). */
export const allowedHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

const cookies = (req: http.IncomingMessage): Record<string, string> => Object.fromEntries((req.headers.cookie || '')
  .split(';').map(c => c.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));

/** Constant-time comparison, so the token cannot be guessed one character at a time. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const hasToken = (req: http.IncomingMessage, token: string): boolean => {
  const header = req.headers[TOKEN_HEADER];
  return same(cookies(req)[COOKIE] || '', token) || (typeof header === 'string' && same(header, token));
};

/**
 * Refuses (throws HttpError) a request whose Host is not this server on a loopback name, and a request that changes
 * something (any method but GET and HEAD) sent from another site's page or not as JSON.
 */
export function guard(req: http.IncomingMessage, port: number): void {
  const hosts = allowedHosts(port);
  if (!hosts.includes(req.headers.host || '')) throw new HttpError(421, `this server answers only to ${hosts[0]}`);
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && !hosts.some(h => origin === `http://${h}`)) throw new HttpError(403, 'requests from other sites are refused');
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'send JSON (Content-Type: application/json)');
}

export async function readBody(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'the body is not valid JSON'); }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
const MIN_COMPRESS = 1024;
/** Compressed bytes, once per file version and encoding for the life of the server. */
const compressed = new Map<string, Buffer>();
/** The sha256 of each index.html's first inline script (by path+mtime), so the CSP can allow exactly that script. */
const inlineHashes = new Map<string, string>();

const inlineScriptHash = (file: string, mtimeMs: number): string => {
  const key = `${file}:${mtimeMs}`;
  let h = inlineHashes.get(key);
  if (h === undefined) {
    const m = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/i.exec(fs.readFileSync(file, 'utf8'));
    h = m ? `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'` : '';
    inlineHashes.set(key, h);
  }
  return h;
};

/** brotli if the client accepts it, else gzip, else none. */
const pickEncoding = (accept: string): 'br' | 'gzip' | null => {
  const ok = (name: string) => accept.split(',').some(p => {
    const [n, ...params] = p.trim().split(';');
    const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
    return (n.toLowerCase() === name || n === '*') && !(q && Number(q.slice(2)) === 0);
  });
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
};

/** A file of the built app from <dir>, else its index.html (the app routes by the URL hash); false when there is no app. */
export function sendStatic(res: http.ServerResponse, dir: string, urlPath: string, request?: http.IncomingMessage): boolean {
  const req = request ?? res.req; // the response knows its request (Node 15.7+), so callers need not pass it
  const root = path.resolve(dir);
  let file = path.resolve(root, `.${decodeURIComponent(urlPath)}`);
  if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'not found');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return false;
  // A symlink inside the root must not lead out of it.
  const realRoot = fs.realpathSync(root);
  file = fs.realpathSync(file);
  if (file !== realRoot && !file.startsWith(realRoot + path.sep)) throw new HttpError(404, 'not found');
  const st = fs.statSync(file);
  const isIndex = path.basename(file) === 'index.html';
  const hashed = file.startsWith(path.join(realRoot, 'assets') + path.sep);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = path.extname(file);
  const script = isIndex ? inlineScriptHash(file, st.mtimeMs) : '';
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': isIndex ? 'no-store' : hashed ? 'public, max-age=31536000, immutable' : 'max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'${script ? ` ${script}` : ''}; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
  };
  if (!isIndex && !hashed) {
    headers.ETag = etag;
    if (req?.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  }
  const enc = COMPRESSIBLE.has(ext) && st.size >= MIN_COMPRESS ? pickEncoding(String(req?.headers['accept-encoding'] || '')) : null;
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
  if (!enc) {
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
    return true;
  }
  const key = `${file}|${st.mtimeMs}|${st.size}|${enc}`;
  let body = compressed.get(key);
  if (!body) {
    const raw = fs.readFileSync(file);
    body = enc === 'br'
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.gzipSync(raw);
    compressed.set(key, body);
  }
  headers['Content-Encoding'] = enc;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
  return true;
}
