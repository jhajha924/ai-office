import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, hookToEvent, ROOT_DIR } from '../server/src/app.ts';
import { createOfficeServer } from '../server/src/http/server.ts';
import type { OfficeServer } from '../server/src/http/server.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import type { OfficeView } from '../server/src/office/types.ts';

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, opts: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8'), headers: res.headers }));
      },
    );
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve({ status: 413, body: '', headers: {} }) : reject(err)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const emptyView = (groups = 0): OfficeView => ({
  floors: [{ name: '私人樓', masked: false, stats: { working: groups, outputs: 0, waiting: 0 } }],
  groups: Array.from({ length: groups }, (_, i) => ({ sessionId: `s${i}`, floor: '私人樓', label: `g${i}`, actors: [], lastActivity: 0 })),
  feed: [],
  handoffs: [],
  generatedAt: Date.now(),
});

describe('local server boundary', () => {
  let server: OfficeServer;
  let port: number;
  let hooks: unknown[];
  let view: OfficeView;
  let listeners: Array<() => void>;
  let webDir: string;

  beforeEach(async () => {
    hooks = [];
    view = emptyView(3);
    listeners = [];
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-web-'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>AI 辦公室</title>');
    server = createOfficeServer({
      port: 0,
      getView: () => view,
      subscribe: (l) => {
        listeners.push(l);
        return () => {};
      },
      onHook: (b) => hooks.push(b),
      webDir,
      assetsDir: path.join(ROOT_DIR, 'assets', 'kenney'),
    });
    port = await server.listen();
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  // office-event-stream spec, Example: 請求檢查
  it.each([
    ['GET /api/state, Host 127.0.0.1', { path: '/api/state' }, 200],
    ['GET /api/state, Host localhost', { path: '/api/state', host: 'localhost:PORT' }, 200],
    ['GET /api/state, Host evil.example', { path: '/api/state', host: 'evil.example:PORT' }, 403],
    ['POST /hook with header, 1KB', { method: 'POST', path: '/hook', headers: { 'X-AI-Office': 'hook' }, body: JSON.stringify({ pad: 'x'.repeat(1000) }) }, 204],
    ['POST /hook without header', { method: 'POST', path: '/hook', body: '{}' }, 403],
    ['POST /hook with header, 65KB', { method: 'POST', path: '/hook', headers: { 'X-AI-Office': 'hook' }, body: 'x'.repeat(65 * 1024) }, 413],
  ] as const)('%s → %i', async (_name, opts, status) => {
    const host = 'host' in opts ? opts.host.replace('PORT', String(port)) : undefined;
    const res = await request(port, { ...opts, host, headers: 'headers' in opts ? { ...opts.headers } : undefined });
    expect(res.status).toBe(status);
  });

  // office-event-stream spec, Scenario: DNS rebinding
  it('returns no office data to a foreign Host', async () => {
    const res = await request(port, { path: '/api/state', host: `evil.example:${port}` });
    expect(res.body).not.toContain('g0');
  });

  it('sends no CORS headers', async () => {
    const res = await request(port, { path: '/api/state', headers: { Origin: 'http://evil.example' } });
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('serves the page and the Kenney models, and refuses path traversal', async () => {
    expect((await request(port, { path: '/' })).status).toBe(200);
    const glb = await request(port, { path: '/assets/kenney/furniture/desk.glb' });
    expect(glb.status).toBe(200);
    expect(glb.headers['content-type']).toBe('model/gltf-binary');
    expect((await request(port, { path: '/assets/kenney/..%2F..%2Fpackage.json' })).status).toBe(403);
  });

  it('passes a valid hook body on', async () => {
    await request(port, { method: 'POST', path: '/hook', headers: { 'X-AI-Office': 'hook' }, body: '{"session_id":"s"}' });
    expect(hooks).toEqual([{ session_id: 's' }]);
  });

  // office-event-stream spec, Scenario: 中途連上 / 短時間大量事件
  it('starts with a snapshot and merges a burst of changes into one view', async () => {
    const messages: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } });
    await new Promise<void>((resolve) => {
      req.on('response', (res) => {
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          for (const m of chunk.split('\n\n')) if (m.startsWith('event:')) messages.push(m);
          resolve();
        });
      });
    });
    expect(messages[0]).toMatch(/^event: snapshot/);
    expect(JSON.parse(messages[0].split('data: ')[1]).groups).toHaveLength(3);
    for (let i = 0; i < 30; i++) {
      view = emptyView(4 + (i % 3));
      for (const l of listeners) l();
    }
    await new Promise((r) => setTimeout(r, 1_400));
    expect(messages.filter((m) => m.startsWith('event: view'))).toHaveLength(1);
    req.destroy();
  });
});

describe('hook body', () => {
  it('treats permission prompts as waiting and ignores the idle reminder', () => {
    expect(hookToEvent({ session_id: 's', cwd: 'D:/x', notification_type: 'permission_prompt' }, 1)?.kind).toBe('waiting');
    expect(hookToEvent({ session_id: 's', cwd: 'D:/x', message: 'Claude needs your permission to use Bash' }, 1)?.kind).toBe('waiting');
    expect(hookToEvent({ session_id: 's', cwd: 'D:/x', notification_type: 'idle_prompt' }, 1)).toBeUndefined();
    expect(hookToEvent({ cwd: 'D:/x', notification_type: 'permission_prompt' }, 1)).toBeUndefined();
  });

  it('is applied to the store through the app', async () => {
    const app = createApp({ port: 0, config: { get: () => DEFAULT_CONFIG }, demo: false, projectsDir: path.join(os.tmpdir(), 'ai-office-none') });
    const port = await app.server.listen();
    await request(port, {
      method: 'POST',
      path: '/hook',
      headers: { 'X-AI-Office': 'hook' },
      body: JSON.stringify({ session_id: 'abc', cwd: 'D:\\home\\x', notification_type: 'permission_prompt' }),
    });
    const state = JSON.parse((await request(port, { path: '/api/state' })).body) as OfficeView;
    expect(state.groups[0].actors[0].status).toBe('waiting');
    await app.stop();
  });
});

describe('start-up', () => {
  // office-event-stream spec, Scenario: 連接埠被占用
  it('exits with code 1 and a Chinese message when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'src', 'main.ts'), '--demo'], {
      env: { ...process.env, AI_OFFICE_PORT: String(busy) },
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    blocker.close();
    expect(code).toBe(1);
    expect(stderr).toContain(`連接埠 ${busy} 已被其他程式使用`);
  });
});
