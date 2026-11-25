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
  /** Workers (cut ③b): by default every call fails, so each stop stops at a stuck decision. */
  worker: (request: AgentRequest) => RunResult = () => ({ ok: false, reason: '組員執行失敗', usage: { turns: 1, durationMs: 100 } });
  private readonly app: string;
  constructor(app: string) {
    this.app = app;
  }
  async run(request: AgentRequest): Promise<RunResult> {
    this.calls += 1;
    if (request.role === 'worker') return this.worker(request);
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

async function start(dispatch: boolean, lookup: LookupEnv = BOTH, worker?: CountingRunner['worker']): Promise<void> {
  const config: OfficeConfig = dispatch
    ? { ...DEFAULT_CONFIG, dispatch: { building: '辦公室', workRoot, models: { president: 'opus', manager: 'sonnet' } } }
    : DEFAULT_CONFIG;
  runner = new CountingRunner(appDir);
  if (worker) runner.worker = worker;
  app = createApp({
    port: 0,
    config: { get: () => config },
    demo: false,
    projectsDir: path.join(tmp, 'claude-projects'),
    dispatchDir: path.join(tmp, 'ai-office-projects'),
    lookup,
    versionCheck: async () => true,
    speclinkReady: async () => true,
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
    expect((await post(port, `/api/decisions/${decision.id}`, { headers: UI(port), body: '{"action":"start","route":["spec","build","qa"]}' })).status).toBe(204);
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
              { id: 'spec', level: 4, name: '規格企劃組', required: true },
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

/** Plans one project over HTTP and presses 開工; returns its id. */
async function startProject(): Promise<string> {
  await post(port, '/api/dispatch', { headers: UI(port), body: '{"text":"相簿網站加一頁作品集"}' });
  await app.dispatch!.idle();
  const view = JSON.parse((await get(port, '/api/state')).body) as OfficeView;
  const confirm = view.dispatch.active!.decisions[0];
  const route = '{"action":"start","route":["analysis","spec","build","qa","release"]}';
  expect((await post(port, `/api/decisions/${confirm.id}`, { headers: UI(port), body: route })).status).toBe(204);
  await app.dispatch!.idle();
  return view.dispatch.active!.projects[0].id;
}

const state = async (): Promise<OfficeView> => JSON.parse((await get(port, '/api/state')).body) as OfficeView;

describe('決策回答與停止專案 API（③b）', () => {
  it('question：answer 1～2000 字才收，其他動作 400；畫面資料帶 work 與選項', async () => {
    await start(true, BOTH, () => ({
      ok: true,
      output: { outcome: 'question', summary: '列了假設', handoff: '', question: { text: '這頁要放幾件作品？', options: ['6 件', '12 件'] } },
      usage: { turns: 1, durationMs: 100 },
    }));
    await startProject();
    const raw = (await get(port, '/api/state')).body;
    const view = JSON.parse(raw) as OfficeView;
    expect(view.dispatch.work).toMatchObject({
      title: '作品集頁面',
      status: 'waiting',
      stop: { index: 1, total: 5, level: 3, name: '需求分析組', required: false },
      decisions: [{ kind: 'question', summary: '這頁要放幾件作品？', options: ['6 件', '12 件'] }],
    });
    expect(raw).not.toContain('secret-root-xyz');
    const q = view.dispatch.work!.decisions[0].id;
    const answer = (body: unknown) => post(port, `/api/decisions/${q}`, { headers: UI(port), body: JSON.stringify(body) });
    expect((await answer({ action: 'answer', text: '' })).status).toBe(400);
    expect((await answer({ action: 'answer', text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await answer({ action: 'retry' })).status).toBe(400);
    expect((await answer({ action: 'skip' })).status).toBe(400);
    expect((await answer({ action: 'answer', text: '12 件' })).status).toBe(204);
  });

  it('stuck：retry 與 skip 依站驗證，必經站 skip → 400「必經站不能跳過」；rejected 的動作不收', async () => {
    await start(true);
    await startProject();
    // 3F is not required: skip works.
    const first = (await state()).dispatch.work!;
    expect(first.stop).toMatchObject({ name: '需求分析組', required: false });
    expect(first.decisions[0].kind).toBe('stuck');
    expect((await post(port, `/api/decisions/${first.decisions[0].id}`, { headers: UI(port), body: '{"action":"accept"}' })).status).toBe(400);
    expect((await post(port, `/api/decisions/${first.decisions[0].id}`, { headers: UI(port), body: '{"action":"skip"}' })).status).toBe(204);
    await app.dispatch!.idle();
    // 4F is required once the route has 5F (cut ③b): skip is refused, retry is taken.
    const spec = (await state()).dispatch.work!;
    expect(spec.stop).toMatchObject({ name: '規格企劃組', required: true });
    const skip = await post(port, `/api/decisions/${spec.decisions[0].id}`, { headers: UI(port), body: '{"action":"skip"}' });
    expect(skip).toEqual({ status: 400, body: '必經站不能跳過' });
    expect((await post(port, `/api/decisions/${spec.decisions[0].id}`, { headers: UI(port), body: '{"action":"retry"}' })).status).toBe(204);
  });

  it('POST /api/projects/<id>/stop：缺標頭 403、成功 204、已結束 404；最近的交辦顯示已停止', async () => {
    await start(true);
    const id = await startProject();
    expect((await post(port, `/api/projects/${id}/stop`, { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await post(port, `/api/projects/${id}/stop`, { headers: UI(port), body: '{}' })).status).toBe(204);
    expect((await post(port, `/api/projects/${id}/stop`, { headers: UI(port), body: '{}' })).status).toBe(404);
    expect((await post(port, '/api/projects/d20991231-001-1/stop', { headers: UI(port), body: '{}' })).status).toBe(404);
    const view = await state();
    expect(view.dispatch.work).toBeUndefined();
    expect(view.dispatch.recent[0].projects[0].status).toBe('stopped');
  });
});
