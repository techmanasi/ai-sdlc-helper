import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sendStatic } from '../web/server/http.js';

const SCRIPT = "try{document.documentElement.dataset.theme='dark'}catch(e){}";
const BIG = 'const x = "hello world";\n'.repeat(200);
let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-static-')));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-outside-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), `<html><head><script>${SCRIPT}</script></head><body><script type="module" src="/a.js"></script></body></html>`);
  fs.writeFileSync(path.join(root, 'assets', 'x-abc123.js'), BIG);
  fs.writeFileSync(path.join(root, 'plain.js'), BIG);
  fs.writeFileSync(path.join(root, 'tiny.js'), 'let a=1;');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

/** Runs sendStatic against a fake response (a Writable with writeHead and the request) and returns what was written. */
async function get(urlPath: string, headers: Record<string, string> = {}) {
  const chunks: Buffer[] = [];
  let status = 0;
  let out: Record<string, any> = {};
  let done!: () => void;
  const finished = new Promise<void>(r => { done = r; });
  const res: any = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); }, final(cb) { done(); cb(); } });
  res.req = { headers };
  res.writeHead = (s: number, h: Record<string, any>) => { status = s; out = h; };
  sendStatic(res, root, urlPath);
  await finished;
  return { status, headers: out, body: Buffer.concat(chunks) };
}

describe('sendStatic', () => {
  test('hashed assets are immutable', async () => {
    const r = await get('/assets/x-abc123.js');
    expect(r.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });
  test('brotli when offered, gzip when only gzip, none for a tiny file; bodies decompress', async () => {
    const br = await get('/plain.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['Content-Encoding']).toBe('br');
    expect(br.headers.Vary).toBe('Accept-Encoding');
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(BIG);
    const gz = await get('/plain.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['Content-Encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.body).toString()).toBe(BIG);
    const none = await get('/plain.js');
    expect(none.headers['Content-Encoding']).toBeUndefined();
    expect(none.body.toString()).toBe(BIG);
    const tiny = await get('/tiny.js', { 'accept-encoding': 'br, gzip' });
    expect(tiny.headers['Content-Encoding']).toBeUndefined();
    expect(tiny.body.toString()).toBe('let a=1;');
  });
  test('ETag and 304 for a plain static file', async () => {
    const first = await get('/plain.js');
    expect(first.headers['Cache-Control']).toMatch(/^max-age=/);
    const etag = first.headers.ETag;
    expect(etag).toMatch(/^W\//);
    const again = await get('/plain.js', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });
  test('a symlink out of the root is refused', async () => {
    await expect(get('/leak.txt')).rejects.toMatchObject({ status: 404 });
  });
  test('index.html is no-store and its CSP carries the inline script hash and no Google host', async () => {
    const r = await get('/');
    expect(r.headers['Cache-Control']).toBe('no-store');
    const hash = createHash('sha256').update(SCRIPT).digest('base64');
    expect(r.headers['Content-Security-Policy']).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(r.headers['Content-Security-Policy']).not.toContain('google');
  });
});
