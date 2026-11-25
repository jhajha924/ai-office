import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineDeps } from '../server/src/dispatch/engine.ts';
import { DispatchEngine } from '../server/src/dispatch/engine.ts';
import { fileHandoffWriter, FOREMAN_MESSAGES } from '../server/src/dispatch/foreman.ts';
import { QA_CHOICES, QA_QUESTION } from '../server/src/dispatch/worker.ts';
import { fileStorage } from '../server/src/dispatch/persist.ts';
import type { AgentRequest, AgentRunner, Dispatch, RunResult } from '../server/src/dispatch/types.ts';
import { panelView } from '../server/src/dispatch/view.ts';
import type { OfficeConfig } from '../server/src/office/config.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import { mainActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';

const WORK = path.join(os.tmpdir(), 'ai-office-foreman-root');
const APP = path.join(WORK, 'album');
const USAGE = { turns: 3, durationMs: 2000 };
const ok = (output: Record<string, unknown>): RunResult => ({ ok: true, output, usage: USAGE });
const done = (extra: Record<string, unknown> = {}): RunResult => ok({ outcome: 'done', summary: '做好了', handoff: '交接重點', ...extra });
const FULL = { route: ['analysis', 'spec', 'build', 'qa', 'release'], doneWhen: {}, risks: [] };

type WorkerScript = (request: AgentRequest, theme: string) => RunResult | Promise<RunResult>;

/** President and managers answer from queues; workers from a script. */
class Runner implements AgentRunner {
  readonly calls: AgentRequest[] = [];
  readonly cancelled: string[] = [];
  president: RunResult[] = [];
  manager: RunResult[] = [];
  worker: WorkerScript = () => done();
  private stopped = new Map<string, (r: RunResult) => void>();
  async run(request: AgentRequest): Promise<RunResult> {
    this.calls.push(request);
    if (request.role === 'president') return this.president.shift() ?? { ok: false, reason: '總裁執行失敗' };
    if (request.role === 'manager') return this.manager.shift() ?? { ok: false, reason: '經理執行失敗' };
    const theme = request.input.role === 'worker' ? request.input.theme : '';
    return this.worker(request, theme);
  }
  /** A worker call that only ends when cancelled. */
  hang(request: AgentRequest): Promise<RunResult> {
    return new Promise((resolve) => this.stopped.set(request.sessionId!, resolve));
  }
  cancel(sessionId: string): void {
    this.cancelled.push(sessionId);
    this.stopped.get(sessionId)?.({ ok: false, reason: '組員已停止' });
  }
  workers(): AgentRequest[] {
    return this.calls.filter((c) => c.role === 'worker');
  }
}

const CONFIG: OfficeConfig = {
  ...DEFAULT_CONFIG,
  dispatch: { building: '辦公室', workRoot: WORK, models: { president: 'opus', manager: 'sonnet' } },
};

let projectsDir: string;
let store: OfficeStore;
let clock: number;
let sessions: number;

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-foreman-'));
  fs.mkdirSync(APP, { recursive: true });
  store = new OfficeStore();
  clock = new Date(2026, 10, 12, 9, 0, 0).getTime();
  sessions = 0;
});
afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

function engine(runner: Runner, extra: Partial<EngineDeps> = {}): DispatchEngine {
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
    newSession: () => `session-${++sessions}`,
    speclinkReady: async () => true,
    writeHandoff: fileHandoffWriter(() => undefined),
    ...extra,
  });
}

/**
 * Waits until nothing runs, answering the 6F check question (review + verify)
 * on the way: most tests are not about that choice.
 */
async function settle(e: DispatchEngine, mode = 'both'): Promise<void> {
  for (;;) {
    await e.idle();
    const q = e.dispatches.flatMap((d) => d.decisions).find((x) => x.kind === 'qa' && x.status === 'open');
    if (!q) return;
    expect(e.answer(q.id, { action: 'qa', mode })).toEqual({ ok: true });
  }
}

/** Plans one project and presses 開工 on it. */
async function start(
  e: DispatchEngine,
  runner: Runner,
  title = '作品集頁面',
  route = FULL,
  kind: 'code' | 'research' = 'code',
  answerQa = true,
): Promise<Dispatch> {
  runner.president.push(ok({ projects: [{ title, kind, cwd: kind === 'code' ? APP : null, brief: `${title} 的說明` }] }));
  runner.manager.push(ok(route));
  expect(e.submit(title)).toMatchObject({ ok: true });
  await settle(e);
  const dispatch = e.dispatches[e.dispatches.length - 1];
  const confirm = dispatch.decisions.find((q) => q.kind === 'confirm' && q.status === 'open')!;
  expect(e.answer(confirm.id, { action: 'start', route: route.route })).toEqual({ ok: true });
  if (answerQa) await settle(e);
  else await e.idle();
  return dispatch;
}

const openDecision = (d: Dispatch) => d.decisions.find((q) => q.status === 'open');

describe('組長取件與逐站執行', () => {
  it('五站依序完成：每站一個新 session、寫交接單、最後轉 done 並串總結', async () => {
    const runner = new Runner();
    runner.worker = (_r, theme) => done({ summary: `${theme} 完成`, ...(theme === 'spec' ? { change: 'add-csv-export' } : {}) });
    const e = engine(runner);
    const d = await start(e, runner);
    const project = d.projects[0];
    expect(project.status).toBe('done');
    expect(runner.workers().map((c) => (c.input.role === 'worker' ? c.input.theme : ''))).toEqual(['analysis', 'spec', 'build', 'qa', 'release']);
    expect(new Set(runner.workers().map((c) => c.sessionId)).size).toBe(5);
    expect(runner.workers().every((c) => c.resume === false)).toBe(true);
    expect(project.summary).toBe('analysis 完成；spec 完成；build 完成；qa 完成；release 完成');
    const files = fs.readdirSync(path.join(projectsDir, d.id, 'handoffs'));
    expect(files).toEqual([
      `${project.id}-01-analysis.md`,
      `${project.id}-02-spec.md`,
      `${project.id}-03-build.md`,
      `${project.id}-04-qa.md`,
      `${project.id}-05-release.md`,
    ]);
    const handoff = fs.readFileSync(path.join(projectsDir, d.id, 'handoffs', files[2]), 'utf-8');
    expect(handoff).toContain('# 5F 工程組：作品集頁面');
    expect(handoff).toContain('- 用量：3 回合・2 秒');
    expect(handoff).toContain('交接重點');
    expect(d.calls.filter((c) => c.role === 'worker').map((c) => c.stop)).toEqual(['analysis', 'spec', 'build', 'qa', 'release']);
  });

  it('4F 回報 change 名稱 (Scenario)：5F 的提示要實作它並附前站交接', async () => {
    const runner = new Runner();
    runner.worker = (_r, theme) => done(theme === 'spec' ? { change: 'add-csv-export', handoff: '注意 BOM' } : {});
    const e = engine(runner);
    const d = await start(e, runner);
    expect(d.projects[0].change).toBe('add-csv-export');
    const build = runner.workers()[2];
    expect(build.prompt).toContain('speclink-apply 技能實作 change add-csv-export');
    expect(build.prompt).toContain('【3F 需求分析組】');
    expect(build.prompt).toContain('【4F 規格企劃組】');
    expect(build.prompt).toContain('交接：注意 BOM');
  });

  it('資料夾還沒有 speclink (Scenario)：轉 waiting、開 blocked 決策，不叫組員；重試通過後開始', async () => {
    let ready = false;
    const runner = new Runner();
    const e = engine(runner, { speclinkReady: async () => ready });
    const d = await start(e, runner);
    expect(d.projects[0].status).toBe('waiting');
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'blocked', summary: '「album」還沒有 speclink：請先在那個資料夾執行 speclink init，再按重試' });
    expect(runner.workers()).toHaveLength(0);
    ready = true;
    expect(e.answer(q.id, { action: 'retry' })).toEqual({ ok: true });
    await settle(e);
    expect(d.projects[0].status).toBe('done');
  });

  it('研究專案不檢查 speclink、用研究工具', async () => {
    const runner = new Runner();
    const e = engine(runner, { speclinkReady: async () => false });
    const d = await start(e, runner, '食譜整理', { route: ['analysis', 'release'], doneWhen: {}, risks: [] }, 'research');
    expect(d.projects[0].status).toBe('done');
    expect(runner.workers()[0].tools).not.toContain('Skill');
  });

  it('兩件排隊依開工先後執行 (Scenario)：A 等你時 B 排隊，A 完成後才做 B', async () => {
    const runner = new Runner();
    let asked = false;
    runner.worker = (r, theme) => {
      if (r.input.role === 'worker' && r.input.title === 'A 專案' && theme === 'analysis' && !asked) {
        asked = true;
        return ok({ outcome: 'question', summary: '列了假設', handoff: '', question: { text: '要幾件？', options: ['6 件'] } });
      }
      return done();
    };
    const e = engine(runner);
    const a = await start(e, runner, 'A 專案');
    expect(a.projects[0].status).toBe('waiting');
    const b = await start(e, runner, 'B 專案');
    expect(b.projects[0].status).toBe('queued');
    const panel = panelView(
      { status: 'ready', dispatches: e.dispatches, active: () => e.active(), current: () => e.foreman.current(), queue: () => e.foreman.queue() },
      CONFIG.departments,
    );
    expect(panel.work).toMatchObject({ title: 'A 專案', status: 'waiting', stop: { index: 1, total: 5, level: 3, name: '需求分析組' } });
    expect(panel.work?.decisions).toEqual([{ id: openDecision(a)!.id, kind: 'question', project: a.projects[0].id, summary: '要幾件？', options: ['6 件'] }]);
    expect(panel.queued).toBe(1);
    expect(panel.recent.find((r) => r.id === b.id)?.projects[0]).toMatchObject({ status: 'queued', ahead: 1 });

    expect(e.answer(openDecision(a)!.id, { action: 'answer', text: '6 件' })).toEqual({ ok: true });
    await settle(e);
    expect(a.projects[0].status).toBe('done');
    expect(b.projects[0].status).toBe('done');
    const titles = runner.workers().map((c) => (c.input.role === 'worker' ? c.input.title : ''));
    expect(titles.lastIndexOf('A 專案')).toBeLessThan(titles.indexOf('B 專案'));
  });
});

describe('6F 退回重做', () => {
  it('第三次不合格 (Scenario)：退回 5F 兩次後開 rejected 決策；照現況放行走到 7F', async () => {
    const runner = new Runner();
    runner.worker = (_r, theme) => (theme === 'qa' ? ok({ outcome: 'rejected', summary: '有問題', handoff: '', findings: ['缺測試', '沒處理 BOM'] }) : done());
    const e = engine(runner);
    const d = await start(e, runner);
    const project = d.projects[0];
    const themes = runner.workers().map((c) => (c.input.role === 'worker' ? c.input.theme : ''));
    expect(themes).toEqual(['analysis', 'spec', 'build', 'qa', 'build', 'qa', 'build', 'qa']);
    expect(runner.workers()[4].prompt).toContain('- 缺測試');
    expect(project.status).toBe('waiting');
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'rejected', summary: '6F 第 3 次不合格：缺測試', findings: ['缺測試', '沒處理 BOM'] });
    runner.worker = () => done();
    expect(e.answer(q.id, { action: 'accept' })).toEqual({ ok: true });
    await settle(e);
    expect(project.status).toBe('done');
    expect(runner.workers().at(-1)?.input).toMatchObject({ theme: 'release' });
  });

  it('再退回重做：計數歸零、回到 5F 並帶 findings', async () => {
    const runner = new Runner();
    runner.worker = (_r, theme) => (theme === 'qa' ? ok({ outcome: 'rejected', summary: 'x', handoff: '', findings: ['缺測試'] }) : done());
    const e = engine(runner);
    const d = await start(e, runner);
    const before = runner.workers().length;
    runner.worker = () => done();
    expect(e.answer(openDecision(d)!.id, { action: 'redo' })).toEqual({ ok: true });
    await settle(e);
    const next = runner.workers()[before];
    expect(next.input).toMatchObject({ theme: 'build' });
    expect(next.prompt).toContain('- 缺測試');
    expect(d.projects[0].status).toBe('done');
  });
});

describe('卡關提問與接續', () => {
  it('3F 問假設 (Scenario)：回答後以 --resume 同一 session 接續，提示含「使用者回答」', async () => {
    const runner = new Runner();
    let n = 0;
    runner.worker = (_r, theme) =>
      theme === 'analysis' && n++ === 0
        ? ok({ outcome: 'question', summary: '列了假設', handoff: '', question: { text: '這頁要放幾件作品？', options: ['6 件', '12 件'] } })
        : done();
    const e = engine(runner);
    const d = await start(e, runner);
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'question', summary: '這頁要放幾件作品？', options: ['6 件', '12 件'] });
    const group = store.groups.get('session-1');
    expect(group?.seat).toEqual({ kind: 'station', level: 3 });
    expect(e.answer(q.id, { action: 'answer', text: '   ' })).toEqual({ ok: false, status: 400, message: FOREMAN_MESSAGES.emptyAnswer });
    expect(e.answer(q.id, { action: 'retry' })).toMatchObject({ ok: false, status: 400 });
    expect(e.answer(q.id, { action: 'answer', text: '12 件' })).toEqual({ ok: true });
    await settle(e);
    const second = runner.workers()[1];
    expect(second).toMatchObject({ sessionId: 'session-1', resume: true });
    expect(second.prompt.startsWith('使用者回答：12 件')).toBe(true);
    expect(d.projects[0].status).toBe('done');
  });

  it('同一站第 6 次提問視為失敗：自動重試一次後開 stuck 決策', async () => {
    const runner = new Runner();
    runner.worker = () => ok({ outcome: 'question', summary: '', handoff: '', question: { text: '還有問題' } });
    const e = engine(runner);
    const d = await start(e, runner);
    for (let i = 0; i < 5; i++) {
      expect(e.answer(openDecision(d)!.id, { action: 'answer', text: `回答 ${i}` })).toEqual({ ok: true });
      await settle(e);
    }
    expect(openDecision(d)).toMatchObject({ kind: 'stuck', summary: '3F 需求分析組 執行失敗：組員的回覆不合規則' });
    expect(runner.workers()).toHaveLength(7);
  });
});

describe('執行失敗與重開', () => {
  it('5F 逾時兩次 (Scenario)：開 stuck 決策', async () => {
    const runner = new Runner();
    runner.worker = (_r, theme) => (theme === 'build' ? { ok: false, reason: '組員逾時' } : done());
    const e = engine(runner);
    const d = await start(e, runner);
    expect(runner.workers().filter((c) => c.input.role === 'worker' && c.input.theme === 'build')).toHaveLength(2);
    expect(openDecision(d)).toMatchObject({ kind: 'stuck', summary: '5F 工程組 執行失敗：組員逾時' });
    expect(d.projects[0].status).toBe('waiting');
  });

  it.each([
    ['build', 'retry', 'build 重叫一次'],
    ['build', 'skip', '前進到下一站'],
    ['qa', 'skip', '400 必經站不能跳過'],
    ['build', 'stop', '專案 stopped'],
  ] as const)('stuck 決策的回答 (spec Example)：%s 站 %s → %s', async (failing, action, expected) => {
    const runner = new Runner();
    runner.worker = (_r, theme) => (theme === failing ? { ok: false, reason: '組員執行失敗', usage: USAGE } : done());
    const e = engine(runner);
    const d = await start(e, runner);
    const q = openDecision(d)!;
    const before = runner.workers().length;
    runner.worker = () => done();
    const reply = e.answer(q.id, { action });
    await settle(e);
    const project = d.projects[0];
    if (expected === '400 必經站不能跳過') {
      expect(reply).toEqual({ ok: false, status: 400, message: FOREMAN_MESSAGES.requiredSkip });
      expect(project.status).toBe('waiting');
      return;
    }
    expect(reply).toEqual({ ok: true });
    if (action === 'retry') {
      expect(runner.workers()[before]).toMatchObject({ input: { theme: 'build' }, resume: true });
      expect(runner.workers()[before].prompt).toContain('上一次執行失敗：組員執行失敗');
      expect(project.status).toBe('done');
    } else if (action === 'skip') {
      expect(runner.workers()[before].input).toMatchObject({ theme: 'qa' });
      expect(project.status).toBe('done');
    } else {
      expect(project.status).toBe('stopped');
      expect(runner.workers()).toHaveLength(before);
    }
  });

  it('伺服器重開：執行中的站轉 waiting 並開 stuck「伺服器重開，執行中斷」；重試以 --resume 接續', async () => {
    const runner = new Runner();
    runner.worker = (r, theme) => (theme === 'build' ? runner.hang(r) : done());
    const e = engine(runner);
    void start(e, runner);
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(fs.readFileSync(path.join(projectsDir, e.dispatches[0].id, 'dispatch.json'), 'utf-8'));
    expect(saved.projects[0]).toMatchObject({ status: 'running', stopIndex: 2 });
    // The session had produced output before (an earlier attempt), so it can be resumed.
    saved.projects[0].sessionStarted = true;
    fs.writeFileSync(path.join(projectsDir, e.dispatches[0].id, 'dispatch.json'), JSON.stringify(saved));

    const runner2 = new Runner();
    const e2 = engine(runner2);
    const d = e2.dispatches[0];
    expect(d.projects[0].status).toBe('waiting');
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'stuck', summary: '5F 工程組 執行失敗：伺服器重開，執行中斷' });
    expect(e2.answer(q.id, { action: 'retry' })).toEqual({ ok: true });
    await settle(e2);
    expect(runner2.workers()[0]).toMatchObject({ resume: true, input: { theme: 'build' } });
    expect(runner2.workers()[0].prompt).toContain('伺服器重開');
    expect(d.projects[0].status).toBe('done');
  });
});

describe('停止專案', () => {
  it('執行中停止 (Scenario)：結束組員程序、專案 stopped、下一件開始', async () => {
    const runner = new Runner();
    runner.worker = (r, theme) => (r.input.role === 'worker' && r.input.title === 'A 專案' && theme === 'build' ? runner.hang(r) : done());
    const e = engine(runner);
    void start(e, runner, 'A 專案');
    await new Promise((r) => setTimeout(r, 50));
    const a = e.dispatches[0];
    expect(a.projects[0]).toMatchObject({ status: 'running', stopIndex: 2 });
    const session = a.projects[0].sessionId!;
    expect(e.stopProject(a.projects[0].id)).toEqual({ ok: true });
    expect(runner.cancelled).toEqual([session]);
    expect(a.projects[0].status).toBe('stopped');
    expect(e.stopProject(a.projects[0].id)).toMatchObject({ ok: false, status: 404 });
    const b = await start(e, runner, 'B 專案');
    expect(b.projects[0].status).toBe('done');
  });
});

describe('組員坐到部門樓層', () => {
  it('5F 組員上工 (Scenario)：5F、職稱組員、名稱以專案標題開頭；觀察層同 session 事件合併後不變', async () => {
    const runner = new Runner();
    runner.worker = (r, theme) => (theme === 'build' ? runner.hang(r) : done());
    const e = engine(runner);
    void start(e, runner, '匯出按鈕');
    await new Promise((r) => setTimeout(r, 50));
    const session = e.dispatches[0].projects[0].sessionId!;
    // The transcript observer sees the same session using a skill of another floor.
    store.apply({ kind: 'skill.use', source: 'observe', sessionId: session, actorId: mainActorId(session), cwd: APP, skill: 'speclink-review', at: clock });
    store.apply({ kind: 'tool.start', source: 'observe', sessionId: session, actorId: mainActorId(session), cwd: APP, tool: 'Edit', toolUseId: 't1', at: clock });
    const view = buildView(store, CONFIG, clock);
    const group = view.groups.find((g) => g.sessionId === session)!;
    expect(group.level).toBe(5);
    expect(group.seat).toEqual({ kind: 'station', level: 5 });
    expect(group.label.startsWith('匯出按鈕・工程組')).toBe(true);
    expect(group.actors[0].title).toBe('組員');
    e.stopProject(e.dispatches[0].projects[0].id);
  });
});

describe('執行狀態存檔', () => {
  it('讀回 ③a 留下的排隊專案 (Scenario)：不直接執行，開 blocked 決策；按重試才開始', async () => {
    const runner = new Runner();
    const e = engine(runner);
    runner.president.push(ok({ projects: [{ title: '舊專案', kind: 'code', cwd: APP, brief: 'x' }] }));
    runner.manager.push(ok(FULL));
    e.submit('舊專案');
    await settle(e);
    const id = e.dispatches[0].id;
    const file = path.join(projectsDir, id, 'dispatch.json');
    const legacy = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // What ③a left behind: queued, no startedAt, the confirm decision answered.
    legacy.status = 'done';
    legacy.projects[0].status = 'queued';
    for (const q of legacy.decisions) q.status = 'answered';
    fs.writeFileSync(file, JSON.stringify(legacy));

    const runner2 = new Runner();
    const e2 = engine(runner2);
    await settle(e2);
    const d = e2.dispatches[0];
    expect(d.projects[0].status).toBe('waiting');
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'blocked', summary: '「舊專案」是派工引擎上線前排隊的專案：按重試開始執行，或停止專案' });
    expect(runner2.workers()).toHaveLength(0);
    expect(e2.answer(q.id, { action: 'retry' })).toEqual({ ok: true });
    await settle(e2);
    expect(d.projects[0].startedAt).toBeTypeOf('number');
    expect(d.projects[0].status).toBe('done');
  });

  it('未知的專案狀態或決策種類：整份交辦略過並警告', () => {
    const dir = path.join(projectsDir, 'd20261112-009');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'dispatch.json'),
      JSON.stringify({ id: 'd20261112-009', building: '辦公室', text: 'x', createdAt: 1, status: 'done', projects: [{ status: 'flying' }], decisions: [], calls: [] }),
    );
    const warnings: string[] = [];
    expect(fileStorage(projectsDir, (m) => warnings.push(m)).loadAll()).toEqual([]);
    expect(warnings).toEqual(['[AI 辦公室] 交辦紀錄 d20261112-009 讀不懂，已略過']);
  });
});

describe('6F 檢查方式由使用者選擇', () => {
  it.each([
    ['review', 204, ['speclink-review'], ['speclink-verify']],
    ['verify', 204, ['speclink-verify'], ['speclink-review']],
    ['both', 204, ['speclink-review', 'speclink-verify'], []],
    ['all', 400, [], []],
  ] as const)('qa 決策的回答 (spec Example)：mode %s → %s', async (mode, status, has, hasNot) => {
    const runner = new Runner();
    const e = engine(runner);
    const d = await start(e, runner, '作品集頁面', { route: ['spec', 'build', 'qa'], doneWhen: {}, risks: [] }, 'code', false);
    // Planning and the first two stops ran; 6F waits for the choice, no qa worker yet.
    const q = openDecision(d)!;
    expect(q).toMatchObject({ kind: 'qa', summary: QA_QUESTION, options: QA_CHOICES.map((c) => c.label) });
    expect(d.projects[0].status).toBe('waiting');
    expect(runner.workers().map((c) => (c.input.role === 'worker' ? c.input.theme : ''))).toEqual(['spec', 'build']);
    expect(store.groups.get(d.projects[0].sessionId!)?.seat).toEqual({ kind: 'station', level: 6 });
    const reply = e.answer(q.id, { action: 'qa', mode });
    if (status === 400) {
      expect(reply).toEqual({ ok: false, status: 400, message: FOREMAN_MESSAGES.badBody });
      return;
    }
    expect(reply).toEqual({ ok: true });
    await e.idle();
    const qa = runner.workers().at(-1)!;
    expect(qa.input).toMatchObject({ theme: 'qa' });
    for (const skill of has) expect(qa.prompt).toContain(skill);
    for (const skill of hasNot) expect(qa.prompt).not.toContain(skill);
    expect(d.projects[0]).toMatchObject({ status: 'done', qaMode: mode });
  });

  it('選只跑 verify (Scenario)：退回 5F 再回到 6F 時不再詢問', async () => {
    const runner = new Runner();
    let rejected = false;
    runner.worker = (_r, theme) => {
      if (theme === 'qa' && !rejected) {
        rejected = true;
        return ok({ outcome: 'rejected', summary: '有問題', handoff: '', findings: ['缺測試'] });
      }
      return done();
    };
    const e = engine(runner);
    const d = await start(e, runner, '作品集頁面', FULL, 'code', false);
    expect(e.answer(openDecision(d)!.id, { action: 'qa', mode: 'verify' })).toEqual({ ok: true });
    await e.idle();
    expect(d.projects[0].status).toBe('done');
    expect(d.decisions.filter((q) => q.kind === 'qa')).toHaveLength(1);
    const qaCalls = runner.workers().filter((c) => c.input.role === 'worker' && c.input.theme === 'qa');
    expect(qaCalls).toHaveLength(2);
    for (const call of qaCalls) {
      expect(call.prompt).toContain('使用 speclink-verify 技能');
      expect(call.prompt).not.toContain('speclink-review');
    }
  });

  it('研究專案的 6F 不詢問', async () => {
    const runner = new Runner();
    const e = engine(runner);
    const d = await start(e, runner, '食譜整理', { route: ['analysis', 'qa', 'release'], doneWhen: {}, risks: [] }, 'research');
    expect(d.decisions.some((q) => q.kind === 'qa')).toBe(false);
    expect(d.projects[0].status).toBe('done');
  });
});
