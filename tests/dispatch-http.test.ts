import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { App } from '../server/src/app.ts';
import { createApp } from '../server/src/app.ts';
import type { LookupEnv } from '../server/src/dispatch/cli.ts';
import type { AgentRequest, AgentRunner, RunResult } from '../server/src/dispatch/types.ts';
import type { OfficeConfig } from '../server/src/office/config.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import type { OfficeView } from '../server/src/office/types.ts';

interface Res {
  status: number;
  body: string;
}

function post(port: number, url: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve({ status: 413, body: '' }) : reject(err)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function get(port: number, url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      })
      .on('error', reject);
  });
}

const UI = (port: number) => ({ 'X-AI-Office': 'ui', 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` });

class CountingRunner implements AgentRunner {
  calls = 0;
  private readonly app: string;
  constructor(app: string) {
    this.app = app;
  }
  async run(request: AgentRequest): Promise<RunResult> {
    this.calls += 1;
    const output =
      request.role === 'president'
        ? { projects: [{ title: '作品集頁面', kind: 'code', cwd: this.app, brief: '加一頁作品集' }] }
        : { route: ['analysis', 'spec', 'build', 'qa', 'release'], doneWhen: {}, risks: ['圖片太大'] };
    return { ok: true, output, usage: { turns: 2, durationMs: 1500 } };
  }
}

let tmp: string;
let workRoot: string;
let appDir: string;
let app: App;
let port: number;
let runner: CountingRunner;

const BOTH: LookupEnv = { pathEnv: 'C:\\bin', platform: 'win32', isFile: (f) => f === 'C:\\bin\\claude.exe' || f === 'C:\\bin\\speclink.exe' };

async function start(dispatch: boolean, lookup: LookupEnv = BOTH): Promise<void> {
  const config: OfficeConfig = dispatch
    ? { ...DEFAULT_CONFIG, dispatch: { building: '辦公室', workRoot, models: { president: 'opus', manager: 'sonnet' } } }
    : DEFAULT_CONFIG;
  runner = new CountingRunner(appDir);
  app = createApp({
    port: 0,
    config: { get: () => config },
    demo: false,
    projectsDir: path.join(tmp, 'claude-projects'),
    dispatchDir: path.join(tmp, 'ai-office-projects'),
    lookup,
    versionCheck: async () => true,
    runner,
    webDir: path.join(tmp, 'web'),
    assetsDir: path.join(tmp, 'assets'),
    warn: () => undefined,
  });
  port = await app.start();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-http-'));
  workRoot = path.join(tmp, 'secret-root-xyz');
  appDir = path.join(workRoot, 'album');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'claude-projects'));
});
afterEach(async () => {
  await app.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('伺服器只服務本機：POST 檢查 (spec「請求檢查」Example 新增的列)', () => {
  const body = JSON.stringify({ text: '相簿網站加一頁作品集' });

  it('X-AI-Office: ui、application/json、Origin http://127.0.0.1:5188 → 依交辦規則（202）', async () => {
    await start(true);
    const res = await post(port, '/api/dispatch', { headers: UI(port), body });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ id: expect.stringMatching(/^d\d{8}-001$/) });
  });

  it('標頭都對、沒有 Origin → 依交辦規則', async () => {
    await start(true);
    const { Origin: _o, ...noOrigin } = UI(port);
    expect((await post(port, '/api/dispatch', { headers: noOrigin, body })).status).toBe(202);
  });

  it.each([
    ['沒有 X-AI-Office 標頭', { 'X-AI-Office': '' }],
    ['X-AI-Office: hook', { 'X-AI-Office': 'hook' }],
    ['Content-Type text/plain', { 'Content-Type': 'text/plain' }],
    ['Origin https://evil.example', { Origin: 'https://evil.example' }],
  ])('%s → 403', async (_label, override) => {
    await start(true);
    const headers: Record<string, string> = { ...UI(port), ...override };
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
    expect((await post(port, '/api/dispatch', { headers, body })).status).toBe(403);
    expect(runner.calls).toBe(0);
  });

  it('POST /api/decisions/x，標頭都對，本文 65KB → 413', async () => {
    await start(true);
    const big = JSON.stringify({ action: 'cancel', pad: 'x'.repeat(65 * 1024) });
    expect((await post(port, '/api/decisions/x', { headers: UI(port), body: big })).status).toBe(413);
  });

  it('別的網頁跨站交辦 (Scenario)：表單 POST → 403，沒有建立交辦也沒有啟動程序', async () => {
    await start(true);
    const res = await post(port, '/api/dispatch', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
      body: 'text=hi',
    });
    expect(res.status).toBe(403);
    expect(app.dispatch!.dispatches).toEqual([]);
    expect(runner.calls).toBe(0);
  });
});

describe('交辦 API', () => {
  it.each([
    ['「相簿網站加一頁作品集」', { text: '相簿網站加一頁作品集' }, 202],
    ['「   」', { text: '   ' }, 400],
    ['2001 個字', { text: '字'.repeat(2001) }, 400],
    ['缺少 text 欄位', {}, 400],
  ])('%s → %i', async (_label, payload, status) => {
    await start(true);
    expect((await post(port, '/api/dispatch', { headers: UI(port), body: JSON.stringify(payload) })).status).toBe(status);
  });

  it('公開版預設不派工 (Scenario)：沒有 dispatch → status off、POST 回 404', async () => {
    await start(false);
    expect((await post(port, '/api/dispatch', { headers: UI(port), body: '{"text":"x"}' })).status).toBe(404);
    const view = JSON.parse((await get(port, '/api/state')).body) as OfficeView;
    expect(view.dispatch).toEqual({ status: 'off', recent: [] });
  });

  it('缺 speclink → 503', async () => {
    await start(true, { ...BOTH, isFile: (f) => f === 'C:\\bin\\claude.exe' });
    expect((await post(port, '/api/dispatch', { headers: UI(port), body: '{"text":"x"}' })).status).toBe(503);
    const view = JSON.parse((await get(port, '/api/state')).body) as OfficeView;
    expect(view.dispatch.status).toBe('missing-speclink');
  });

  it('回答決策：開工回 204，不存在的決策回 404', async () => {
    await start(true);
    await post(port, '/api/dispatch', { headers: UI(port), body: '{"text":"相簿網站加一頁作品集"}' });
    await app.dispatch!.idle();
    const view = JSON.parse((await get(port, '/api/state')).body) as OfficeView;
    const decision = view.dispatch.active!.decisions[0];
    expect(decision.kind).toBe('confirm');
    expect((await post(port, `/api/decisions/${decision.id}`, { headers: UI(port), body: '{"action":"start","route":["build","qa"]}' })).status).toBe(204);
    expect((await post(port, '/api/decisions/nosuch', { headers: UI(port), body: '{"action":"cancel"}' })).status).toBe(404);
  });
});

describe('OfficeView.dispatch', () => {
  it('欄位內容正確，整份 OfficeView 不含 workRoot 與專案完整路徑', async () => {
    await start(true);
    await post(port, '/api/dispatch', { headers: UI(port), body: '{"text":"相簿網站加一頁作品集"}' });
    await app.dispatch!.idle();
    const raw = (await get(port, '/api/state')).body;
    const view = JSON.parse(raw) as OfficeView;
    expect(view.dispatch).toMatchObject({
      status: 'ready',
      building: '辦公室',
      active: {
        status: 'confirm',
        text: '相簿網站加一頁作品集',
        usage: { turns: 4, durationMs: 3000 },
        projects: [
          {
            title: '作品集頁面',
            kind: 'code',
            folder: 'album',
            status: 'confirm',
            risks: ['圖片太大'],
            route: [
              { id: 'analysis', level: 3, name: '需求分析組', required: false },
              { id: 'spec', level: 4, name: '規格企劃組', required: false },
              { id: 'build', level: 5, name: '工程組', required: false },
              { id: 'qa', level: 6, name: '測試品管組', required: true },
              { id: 'release', level: 7, name: '文件發佈組', required: false },
            ],
          },
        ],
      },
      recent: [],
    });
    expect(raw).not.toContain('secret-root-xyz');
    expect(raw).not.toContain(JSON.stringify(appDir).slice(1, -1));
    expect(raw).not.toContain(tmp.replace(/\\/g, '\\\\'));
  });

  it('done 的交辦進 recent，最近 5 件、新的在前', async () => {
    await start(true);
    for (let i = 0; i < 6; i++) {
      await post(port, '/api/dispatch', { headers: UI(port), body: JSON.stringify({ text: `事情 ${i}` }) });
      await app.dispatch!.idle();
      const id = app.dispatch!.active()!.decisions.find((q) => q.status === 'open')!.id;
      app.dispatch!.answer(id, { action: 'cancel' });
    }
    const view = JSON.parse((await get(port, '/api/state')).body) as OfficeView;
    expect(view.dispatch.active).toBeUndefined();
    expect(view.dispatch.recent.map((d) => d.text)).toEqual(['事情 5', '事情 4', '事情 3', '事情 2', '事情 1']);
  });
});
