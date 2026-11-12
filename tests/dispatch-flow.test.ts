import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineDeps } from '../server/src/dispatch/engine.ts';
import { DispatchEngine, managerSession, MESSAGES, presidentSession } from '../server/src/dispatch/engine.ts';
import { fileStorage } from '../server/src/dispatch/persist.ts';
import type { AgentRequest, AgentRunner, RunResult } from '../server/src/dispatch/types.ts';
import type { OfficeConfig } from '../server/src/office/config.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import { buildView } from '../server/src/office/view.ts';

const WORK = path.join(os.tmpdir(), 'ai-office-work-root');
const APP = path.join(WORK, 'album');
const USAGE = { turns: 2, durationMs: 1000 };
const ok = (output: Record<string, unknown>): RunResult => ({ ok: true, output, usage: USAGE });
const fail = (reason: string): RunResult => ({ ok: false, reason });

const codeProject = (title: string) => ({ title, kind: 'code', cwd: APP, brief: `${title} 的說明` });
const researchProject = (title: string) => ({ title, kind: 'research', cwd: null, brief: `${title} 的說明` });
const FULL = { route: ['analysis', 'spec', 'build', 'qa', 'release'], doneWhen: {}, risks: [] };

/** Answers president and manager calls from two queues, in order. */
class ScriptedRunner implements AgentRunner {
  readonly calls: AgentRequest[] = [];
  president: RunResult[];
  manager: RunResult[];
  constructor(president: RunResult[], manager: RunResult[]) {
    this.president = president;
    this.manager = manager;
  }
  async run(request: AgentRequest): Promise<RunResult> {
    this.calls.push(request);
    const next = (request.role === 'president' ? this.president : this.manager).shift();
    return next ?? fail(request.role === 'president' ? '總裁執行失敗' : '經理執行失敗');
  }
}

const CONFIG: OfficeConfig = {
  ...DEFAULT_CONFIG,
  dispatch: { building: '辦公室', workRoot: WORK, models: { president: 'opus', manager: 'sonnet' } },
};

let projectsDir: string;
let store: OfficeStore;
let clock: number;

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-projects-'));
  fs.mkdirSync(APP, { recursive: true });
  store = new OfficeStore();
  clock = new Date(2026, 10, 10, 9, 0, 0).getTime();
});
afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

function engine(runner: AgentRunner, extra: Partial<EngineDeps> = {}): DispatchEngine {
  return new DispatchEngine({
    settings: CONFIG.dispatch!,
    status: 'ready',
    departments: () => CONFIG.departments,
    runner,
    projectsDir,
    storage: fileStorage(projectsDir, () => undefined),
    emit: (e) => store.apply(e),
    setLabel: (s, l) => store.setLabel(s, l),
    occupiedOffices: () => new Set(),
    now: () => (clock += 10),
    makeDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    ...extra,
  });
}

/** One code project, its route confirmed or not yet. */
async function oneCodeProject(route = FULL): Promise<{ e: DispatchEngine; decision: string }> {
  const e = engine(new ScriptedRunner([ok({ projects: [codeProject('作品集頁面')] })], [ok(route)]));
  expect(e.submit('相簿網站加一頁作品集')).toMatchObject({ ok: true, id: 'd20261110-001' });
  await e.idle();
  const d = e.dispatches[0];
  return { e, decision: d.decisions.find((q) => q.kind === 'confirm')!.id };
}

describe('路線確認決策 (spec「回答驗證」Example，code 專案原路線 analysis、spec、build、qa、release)', () => {
  it.each([
    [{ action: 'start', route: ['build', 'qa'] }, 204, 'queued'],
    [{ action: 'start', route: ['build'] }, 400, '改程式的專案一定要經過 6F 測試品管組'],
    [{ action: 'start', route: [] }, 400, MESSAGES.emptyRoute],
    [{ action: 'start', route: ['build', 'qa', 'marketing'] }, 400, MESSAGES.foreignStop],
    [{ action: 'cancel' }, 204, 'cancelled'],
  ] as const)('%j → %s %s', async (body, status, expected) => {
    const { e, decision } = await oneCodeProject();
    const reply = e.answer(decision, body);
    if (status === 204) {
      expect(reply).toEqual({ ok: true });
      expect(e.dispatches[0].projects[0].status).toBe(expected);
      expect(e.dispatches[0].status).toBe('done');
    } else {
      expect(reply).toEqual({ ok: false, status, message: expected });
      expect(e.dispatches[0].status).toBe('confirm');
    }
  });

  it('同一件決策回答第二次 → 404', async () => {
    const { e, decision } = await oneCodeProject();
    expect(e.answer(decision, { action: 'cancel' })).toEqual({ ok: true });
    expect(e.answer(decision, { action: 'cancel' })).toMatchObject({ ok: false, status: 404 });
  });

  it('刪站後開工 (Scenario)：route 依樓層重排，沒有新的 claude 程序', async () => {
    const runner = new ScriptedRunner([ok({ projects: [codeProject('作品集頁面')] })], [ok(FULL)]);
    const e = engine(runner);
    e.submit('相簿網站加一頁作品集');
    await e.idle();
    const decision = e.dispatches[0].decisions.find((q) => q.kind === 'confirm')!.id;
    const before = runner.calls.length;
    expect(e.answer(decision, { action: 'start', route: ['release', 'build', 'qa'] })).toEqual({ ok: true });
    await e.idle();
    const project = e.dispatches[0].projects[0];
    expect(project.status).toBe('queued');
    expect(project.route.map((s) => s.id)).toEqual(['build', 'qa', 'release']);
    expect(runner.calls.length).toBe(before);
  });

  it('研究專案開工時才建立產出資料夾', async () => {
    const e = engine(new ScriptedRunner([ok({ projects: [researchProject('食譜整理')] })], [ok({ route: ['analysis', 'release'], doneWhen: {}, risks: [] })]));
    e.submit('幫我整理食譜清單');
    await e.idle();
    const project = e.dispatches[0].projects[0];
    expect(project.cwd).toBe(path.join(projectsDir, 'd20261110-001', 'output', '1'));
    expect(fs.existsSync(project.cwd)).toBe(false);
    e.answer(e.dispatches[0].decisions[0].id, { action: 'start', route: ['analysis', 'release'] });
    expect(fs.existsSync(project.cwd)).toBe(true);
  });
});

describe('一次一件交辦', () => {
  it('已有交辦在處理 (Scenario)：回 409，不啟動任何程序', async () => {
    const runner = new ScriptedRunner([ok({ projects: [codeProject('作品集頁面')] })], [ok(FULL)]);
    const e = engine(runner);
    e.submit('相簿網站加一頁作品集');
    await e.idle();
    expect(e.dispatches[0].status).toBe('confirm');
    const calls = runner.calls.length;
    expect(e.submit('另一件事')).toEqual({ ok: false, status: 409, message: MESSAGES.busy });
    expect(runner.calls.length).toBe(calls);
  });

  it.each([
    ['   ', 400],
    ['字'.repeat(2001), 400],
    [undefined, 400],
    ['相簿網站加一頁作品集', true],
  ] as const)('交辦本文檢查 %j → %s', (text, expected) => {
    const e = engine(new ScriptedRunner([], []));
    const reply = e.submit(text);
    if (expected === true) expect(reply.ok).toBe(true);
    else expect(reply).toMatchObject({ ok: false, status: expected });
  });

  it('off 回 404、未 ready 回 503', () => {
    expect(engine(new ScriptedRunner([], []), { status: 'off' }).submit('x')).toMatchObject({ status: 404 });
    expect(engine(new ScriptedRunner([], []), { status: 'missing-speclink' }).submit('x')).toMatchObject({ status: 503 });
  });
});

describe('失敗、逾時與重試', () => {
  it('第一次失敗自動重試一次就成功 → 不打擾使用者', async () => {
    const e = engine(new ScriptedRunner([fail('總裁的回覆不是 JSON'), ok({ projects: [codeProject('作品集頁面')] })], [ok(FULL)]));
    e.submit('相簿網站加一頁作品集');
    await e.idle();
    expect(e.dispatches[0].status).toBe('confirm');
    expect(e.dispatches[0].calls.map((c) => c.ok)).toEqual([false, true, true]);
  });

  it('第二個經理逾時兩次 (Scenario)：failed「經理逾時」，retry 只重叫第二位經理', async () => {
    const runner = new ScriptedRunner(
      [ok({ projects: [codeProject('作品集頁面'), researchProject('競品研究')] })],
      [ok(FULL), fail('經理逾時'), fail('經理逾時')],
    );
    const e = engine(runner);
    e.submit('相簿網站加一頁作品集，另外研究競品');
    await e.idle();
    const d = e.dispatches[0];
    expect(d.status).toBe('failed');
    expect(d.error).toBe('經理逾時');
    const firstRoute = d.projects[0].route;
    runner.manager.push(ok({ route: ['analysis', 'release'], doneWhen: {}, risks: [] }));
    const retry = d.decisions.find((q) => q.kind === 'retry' && q.status === 'open')!.id;
    const before = runner.calls.length;
    expect(e.answer(retry, { action: 'retry' })).toEqual({ ok: true });
    await e.idle();
    expect(runner.calls.slice(before).map((c) => (c.input.role === 'manager' ? c.input.title : c.role))).toEqual(['競品研究']);
    expect(d.projects[0].route).toBe(firstRoute);
    expect(d.status).toBe('confirm');
  });

  it('總裁給了範圍外的資料夾兩次 → failed，沒有建立任何資料夾', async () => {
    const outside = { title: '外面', kind: 'code', cwd: path.join(os.tmpdir(), 'elsewhere-app'), brief: 'x' };
    const e = engine(new ScriptedRunner([ok({ projects: [outside] }), ok({ projects: [outside] })], []));
    e.submit('改外面的程式');
    await e.idle();
    expect(e.dispatches[0]).toMatchObject({ status: 'failed', error: '總裁給的資料夾不在可派工範圍' });
    expect(fs.existsSync(outside.cwd)).toBe(false);
  });

  it('失敗後取消 → done，尚未確認的專案 cancelled', async () => {
    const e = engine(new ScriptedRunner([ok({ projects: [codeProject('作品集頁面'), researchProject('競品研究')] })], [ok(FULL), fail('經理逾時'), fail('經理逾時')]));
    e.submit('兩件事');
    await e.idle();
    const retry = e.dispatches[0].decisions.find((q) => q.kind === 'retry')!.id;
    expect(e.answer(retry, { action: 'cancel' })).toEqual({ ok: true });
    expect(e.dispatches[0].status).toBe('done');
    expect(e.dispatches[0].projects.map((p) => p.status)).toEqual(['cancelled', 'cancelled']);
    expect(e.submit('下一件').ok).toBe(true);
  });
});

describe('交辦存檔與重開', () => {
  it('經理排到一半伺服器重開 (Scenario)：failed「伺服器重開，呼叫中斷」並可重試', async () => {
    let release: (r: RunResult) => void = () => undefined;
    const hanging: AgentRunner = {
      run: (req) => (req.role === 'president' ? Promise.resolve(ok({ projects: [codeProject('作品集頁面')] })) : new Promise((r) => (release = r))),
    };
    const first = engine(hanging);
    first.submit('相簿網站加一頁作品集');
    await new Promise((r) => setTimeout(r, 20));
    expect(first.dispatches[0].status).toBe('manager');

    const reborn = engine(new ScriptedRunner([], [ok(FULL)]));
    const d = reborn.dispatches[0];
    expect(d).toMatchObject({ id: 'd20261110-001', status: 'failed', error: MESSAGES.interrupted });
    const retry = d.decisions.find((q) => q.kind === 'retry' && q.status === 'open')!.id;
    expect(reborn.answer(retry, { action: 'retry' })).toEqual({ ok: true });
    await reborn.idle();
    expect(d.status).toBe('confirm');
    release(fail('經理逾時'));
  });

  it('壞檔略過並警告，其他交辦照常；流水號接續', async () => {
    const e = engine(new ScriptedRunner([ok({ projects: [codeProject('作品集頁面')] })], [ok(FULL)]));
    e.submit('相簿網站加一頁作品集');
    await e.idle();
    e.answer(e.dispatches[0].decisions[0].id, { action: 'cancel' });
    fs.mkdirSync(path.join(projectsDir, 'd20261110-009'));
    fs.writeFileSync(path.join(projectsDir, 'd20261110-009', 'dispatch.json'), '{ broken');
    const warnings: string[] = [];
    const again = engine(new ScriptedRunner([], []), { storage: fileStorage(projectsDir, (m) => warnings.push(m)) });
    expect(again.dispatches.map((d) => d.id)).toEqual(['d20261110-001']);
    expect(warnings).toEqual(['[AI 辦公室] 交辦紀錄 d20261110-009 讀不懂，已略過']);
    expect(again.submit('下一件')).toMatchObject({ ok: true, id: 'd20261110-002' });
  });

  it('存檔含 cwd 與每次呼叫的用量', async () => {
    await oneCodeProject();
    const saved = JSON.parse(fs.readFileSync(path.join(projectsDir, 'd20261110-001', 'dispatch.json'), 'utf-8'));
    expect(saved.projects[0].cwd).toBe(APP);
    expect(saved.calls.map((c: { role: string; usage: unknown }) => [c.role, c.usage])).toEqual([
      ['president', USAGE],
      ['manager', USAGE],
    ]);
  });
});

describe('總裁與經理坐在自己的位置（伺服器端）', () => {
  it('經理等你確認 (Scenario)：2F、職稱經理、等你；看板的資料來源有它', async () => {
    await oneCodeProject();
    const view = buildView(store, CONFIG, clock);
    const manager = view.groups.find((g) => g.sessionId === managerSession('d20261110-001-1'))!;
    expect(manager).toMatchObject({ level: 2, seat: { kind: 'manager', office: 1 }, label: '作品集頁面', building: '辦公室' });
    expect(manager.actors[0]).toMatchObject({ title: '經理', status: 'waiting', bubble: '等你確認路線' });
    const president = view.groups.find((g) => g.sessionId === presidentSession('d20261110-001'))!;
    expect(president).toMatchObject({ level: 1, seat: { kind: 'president' }, label: '相簿網站加一頁作品集' });
    expect(president.actors[0]).toMatchObject({ title: '總裁', status: 'done' });
  });

  it.each([
    [{ kind: 'president' }, undefined, 1],
    [{ kind: 'manager', office: 3 }, 'speclink-apply', 2],
    [undefined, 'speclink-apply', 5],
  ] as const)('seat %j、技能 %s → 樓層 %i', (seat, skill, level) => {
    const at = clock;
    store.apply({ kind: 'turn.start', source: seat ? 'dispatch' : 'observe', sessionId: 's1', actorId: 's1:main', cwd: WORK, at, ...(seat ? { seat } : {}) });
    if (skill) store.apply({ kind: 'skill.use', source: 'observe', sessionId: 's1', actorId: 's1:main', cwd: WORK, skill, at });
    expect(buildView(store, CONFIG, at).groups[0].level).toBe(level);
  });

  it('派工來源的經理坐 2F (Scenario)', () => {
    store.apply({ kind: 'turn.start', source: 'dispatch', sessionId: 'dispatch-d20261110-001-1-manager', actorId: 'dispatch-d20261110-001-1-manager:main', cwd: WORK, seat: { kind: 'manager', office: 1 }, at: clock });
    const group = buildView(store, CONFIG, clock).groups[0];
    expect(group).toMatchObject({ sessionId: 'dispatch-d20261110-001-1-manager', level: 2, seat: { kind: 'manager', office: 1 } });
  });

  it('經理室取空著的最小號碼', async () => {
    const e = engine(new ScriptedRunner([ok({ projects: [codeProject('甲'), codeProject('乙')] })], [ok(FULL), ok(FULL)]), {
      occupiedOffices: () => new Set([1, 3]),
    });
    e.submit('兩件事');
    await e.idle();
    expect(e.dispatches[0].projects.map((p) => p.office)).toEqual([2, 4]);
  });
});

describe('示範模式的派工', () => {
  it('示範模式交辦 (Scenario)：研究專案、3F → 7F、各等 3 秒、不呼叫 claude 不寫檔', async () => {
    const { createApp } = await import('../server/src/app.ts');
    const { DemoRunner } = await import('../server/src/dispatch/demoRunner.ts');
    const waits: number[] = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-demo-'));
    const dispatchDir = path.join(tmp, 'projects');
    const app = createApp({
      port: 0,
      config: { get: () => DEFAULT_CONFIG },
      demo: true,
      projectsDir: path.join(tmp, 'claude'),
      dispatchDir,
      runner: new DemoRunner(3_000, async (ms) => void waits.push(ms)),
      webDir: tmp,
      assetsDir: tmp,
    });
    // The real projects folder may already hold today's real dispatches: compare before and after.
    const realProjects = path.join(os.homedir(), '.ai-office', 'projects');
    const listReal = (): string[] => (fs.existsSync(realProjects) ? fs.readdirSync(realProjects).sort() : []);
    const before = listReal();
    await app.start();
    try {
      const engine = app.dispatch!;
      expect(engine.status).toBe('ready');
      expect(engine.settings.building).toBe('私人樓');
      expect(engine.submit('幫我整理食譜清單')).toMatchObject({ ok: true });
      await engine.idle();
      const d = engine.dispatches[0];
      expect(waits).toEqual([3_000, 3_000]);
      expect(d.projects).toHaveLength(1);
      expect(d.projects[0]).toMatchObject({ title: '幫我整理食譜清單', kind: 'research', status: 'confirm' });
      expect(d.projects[0].route.map((s) => s.id)).toEqual(['analysis', 'release']);
      expect(d.calls.every((c) => c.usage?.turns === 0)).toBe(true);
      // The manager is in office 1 on 2F of the demo's 私人樓.
      const manager = app.store.groups.get(managerSession(d.projects[0].id))!;
      expect(manager.seat).toEqual({ kind: 'manager', office: 1 });
      expect(engine.answer(d.decisions[0].id, { action: 'start', route: ['analysis', 'release'] })).toEqual({ ok: true });
      expect(fs.existsSync(dispatchDir)).toBe(false);
      expect(listReal()).toEqual(before);
    } finally {
      await app.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('示範模式的程式專案：資料夾「示範專案」、完整五站', async () => {
    const { DemoRunner, DEMO_DISPATCH } = await import('../server/src/dispatch/demoRunner.ts');
    const e = new DispatchEngine({
      settings: DEMO_DISPATCH,
      status: 'ready',
      departments: () => DEFAULT_CONFIG.departments,
      runner: new DemoRunner(0, async () => undefined),
      projectsDir: DEMO_DISPATCH.workRoot,
      emit: (ev) => store.apply(ev),
      setLabel: (s, l) => store.setLabel(s, l),
      occupiedOffices: () => new Set(),
      now: () => (clock += 10),
      isDir: () => true,
    });
    e.submit('相簿網站加一頁作品集');
    await e.idle();
    const p = e.dispatches[0].projects[0];
    expect(p).toMatchObject({ kind: 'code', title: '相簿網站加一頁作品集' });
    expect(path.win32.basename(p.cwd)).toBe('示範專案');
    expect(p.route.map((s) => s.id)).toEqual(['analysis', 'spec', 'build', 'qa', 'release']);
  });
});
