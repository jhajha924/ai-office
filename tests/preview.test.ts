import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROOT_DIR } from '../server/src/app.ts';
import { createOfficeServer } from '../server/src/http/server.ts';
import type { OfficeServer } from '../server/src/http/server.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { outputToken } from '../server/src/office/feed.ts';
import { PREVIEW_MAX_BYTES, previewOutput } from '../server/src/office/outputPreview.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import { mainActorId } from '../server/src/office/types.ts';

function get(port: number, p: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      })
      .on('error', reject);
  });
}

describe('output preview', () => {
  let root: string;
  let home: string;
  let work: string;
  let server: OfficeServer;
  let port: number;
  let store: OfficeStore;
  const config = () => ({
    ...DEFAULT_CONFIG,
    buildings: { ...DEFAULT_CONFIG.buildings, rules: [{ prefix: work, building: '工作樓', mask: true }] },
  });

  /** Writes a file the session "wrote today" and returns its token. */
  function output(sessionId: string, cwd: string, name: string, content: string | Buffer): string {
    const file = path.join(cwd, name);
    fs.writeFileSync(file, content);
    store.apply({ kind: 'output.add', source: 'observe', sessionId, actorId: mainActorId(sessionId), cwd, detail: file, at: Date.now() });
    return outputToken(sessionId, file);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-preview-'));
    home = path.join(root, 'home');
    work = path.join(root, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
    store = new OfficeStore();
    store.setHome('p', { cwd: home });
    store.setHome('w', { cwd: work });
    server = createOfficeServer({
      port: 0,
      getView: () => ({ buildings: [], groups: [], feed: [], handoffs: [], generatedAt: 0 }),
      subscribe: () => () => {},
      onHook: () => {},
      getOutput: (token) => previewOutput(store, config(), token),
      webDir: root,
      assetsDir: path.join(ROOT_DIR, 'assets', 'kenney'),
    });
    port = await server.listen();
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // office-staff-cards spec, Example: 預覽請求
  it('returns the content of a file a private session wrote', async () => {
    const token = output('p', home, '週報草稿.md', '# 週報\n- 12 筆\n');
    const res = await get(port, `/api/output/${token}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ name: '週報草稿.md', text: '# 週報\n- 12 筆\n', truncated: false, binary: false });
  });

  it('answers 404 to a guessed token', async () => {
    output('p', home, 'a.md', 'x');
    expect((await get(port, '/api/output/0123456789abcdef')).status).toBe(404);
  });

  // office-staff-cards spec, Scenario: 遮罩樓層的預覽請求
  it('answers 403 「此樓層不提供預覽」 for a masked-building file and never reads it', async () => {
    const token = output('w', work, 'Billing.pas', 'secret');
    const res = await get(port, `/api/output/${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toBe('此樓層不提供預覽');
    expect(res.body).not.toContain('Billing');
  });

  it('answers 404 when the file is gone', async () => {
    const token = output('p', home, 'gone.md', 'x');
    fs.rmSync(path.join(home, 'gone.md'));
    expect((await get(port, `/api/output/${token}`)).status).toBe(404);
  });

  it('cuts a 300KB text file at 256KB', async () => {
    const token = output('p', home, 'big.txt', 'a'.repeat(300 * 1024));
    const body = JSON.parse((await get(port, `/api/output/${token}`)).body);
    expect(body.truncated).toBe(true);
    expect(body.text).toHaveLength(PREVIEW_MAX_BYTES);
  });

  it('flags a PNG as binary without its content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const token = output('p', home, 'shot.png', png);
    const body = JSON.parse((await get(port, `/api/output/${token}`)).body);
    expect(body).toEqual({ name: 'shot.png', text: '', truncated: false, binary: true });
  });

  it('answers 404 to a malformed token and 403 to a foreign Host', async () => {
    const token = output('p', home, 'a.md', 'x');
    expect((await get(port, '/api/output/..%2F..%2Fetc')).status).toBe(404);
    expect((await get(port, '/api/output/ZZZ')).status).toBe(404);
    expect((await get(port, `/api/output/${token}`, `evil.example:${port}`)).status).toBe(403);
  });

  it('takes demo text instead of reading the file', async () => {
    const token = outputToken('p', path.join(home, 'demo.md'));
    store.apply({ kind: 'output.add', source: 'demo', sessionId: 'p', actorId: mainActorId('p'), cwd: home, detail: path.join(home, 'demo.md'), at: Date.now() });
    const result = await previewOutput(store, config(), token, async () => '示範內容');
    expect(result).toEqual({ status: 200, body: { name: 'demo.md', text: '示範內容', truncated: false, binary: false } });
  });
});
