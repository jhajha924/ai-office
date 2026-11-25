import { describe, expect, it } from 'vitest';

import type { DispatchPanelView, DispatchView, ProjectView } from '../server/src/office/types.ts';
import { buttonModel, confirmCards, drawerModel, projectStatusText, recentModel, routeToStart, viewAfterDispatch, workModel } from '../web/src/dispatch.ts';
import type { WorkView } from '../server/src/office/types.ts';
import { QA_CHOICES } from '../server/src/dispatch/worker.ts';

const project = (over: Partial<ProjectView> = {}): ProjectView => ({
  id: 'd20261110-001-1',
  title: '作品集頁面',
  kind: 'code',
  folder: 'album',
  route: [
    { id: 'analysis', level: 3, name: '需求分析組', doneWhen: '假設清單經使用者確認', required: false },
    { id: 'build', level: 5, name: '工程組', doneWhen: 'tasks.md 程式任務全部勾選', required: false },
    { id: 'qa', level: 6, name: '測試品管組', doneWhen: '測試全過、審查沒有必修項', required: true },
  ],
  notes: [],
  risks: [],
  status: 'confirm',
  ...over,
});

const dispatch = (over: Partial<DispatchView> = {}): DispatchView => ({
  id: 'd20261110-001',
  text: '相簿網站加一頁作品集',
  status: 'confirm',
  projects: [project()],
  decisions: [{ id: 'q1', kind: 'confirm', project: 'd20261110-001-1', summary: '確認「作品集頁面」的路線' }],
  usage: { turns: 4, durationMs: 61_000 },
  ...over,
});

const panel = (active?: DispatchView, over: Partial<DispatchPanelView> = {}): DispatchPanelView => ({
  status: 'ready',
  building: '私人樓',
  ...(active ? { active } : {}),
  recent: [],
  ...over,
});

describe('抽屜內容 (spec Example)', () => {
  it('沒有進行中的交辦 → 送出表單', () => {
    expect(drawerModel(panel())).toEqual({ kind: 'form', building: '私人樓', recent: [] });
  });

  it('president → 總裁拆解中…', () => {
    expect(drawerModel(panel(dispatch({ status: 'president', projects: [], decisions: [] })))).toEqual({ kind: 'busy', text: '總裁拆解中…', cards: [] });
  });

  it('manager，第 2 個專案共 3 個 → 經理排路線中（第 2／共 3 個專案）…', () => {
    const model = drawerModel(panel(dispatch({ status: 'manager', step: { index: 2, total: 3 }, decisions: [] })));
    expect(model).toEqual({ kind: 'busy', text: '經理排路線中（第 2／共 3 個專案）…', cards: [] });
  });

  it('confirm → 每個專案一張確認卡', () => {
    const model = drawerModel(panel(dispatch()));
    expect(model.kind).toBe('confirm');
    expect(model.kind === 'confirm' && model.cards.map((c) => [c.title, c.kind, c.folder])).toEqual([['作品集頁面', '程式', 'album']]);
  });

  it('failed，經理逾時 → 經理逾時、重試、取消', () => {
    const model = drawerModel(panel(dispatch({ status: 'failed', error: '經理逾時', decisions: [{ id: 'r1', kind: 'retry', summary: '交辦失敗：經理逾時' }] })));
    expect(model).toEqual({ kind: 'failed', error: '經理逾時', decision: 'r1', cards: [] });
  });
});

describe('交辦按鈕', () => {
  it('缺 speclink (Scenario)：停用，滑過顯示「找不到 speclink，派工需要它」', () => {
    expect(buttonModel(panel(undefined, { status: 'missing-speclink' }))).toEqual({ hidden: false, disabled: true, title: '找不到 speclink，派工需要它', badge: 0 });
  });

  it('缺 claude → 停用並說明；off → 不顯示', () => {
    expect(buttonModel(panel(undefined, { status: 'missing-claude' })).title).toBe('找不到 claude，派工需要它');
    expect(buttonModel({ status: 'off', recent: [] }).hidden).toBe(true);
  });

  it('有未回答的決策 → 數字徽章', () => {
    expect(buttonModel(panel(dispatch())).badge).toBe(1);
    expect(buttonModel(panel()).badge).toBe(0);
  });
});

describe('確認卡的刪站', () => {
  it('必經站沒有刪除鈕，其他站有', () => {
    const [card] = confirmCards(dispatch());
    expect(card.chips.map((c) => [c.text, c.removable])).toEqual([
      ['3F 需求分析組', true],
      ['5F 工程組', true],
      ['6F 測試品管組', false],
    ]);
  });

  it('刪站後送出的 route 只剩沒刪的站；必經站就算被標記也照樣送出', () => {
    const removed = new Map([['d20261110-001-1', new Set(['analysis', 'qa'])]]);
    const [card] = confirmCards(dispatch(), removed);
    expect(card.chips.map((c) => c.removed)).toEqual([true, false, false]);
    expect(routeToStart(card)).toEqual(['build', 'qa']);
  });

  it('最近的交辦顯示排隊中或已取消與用量', () => {
    const done = dispatch({ status: 'done', decisions: [], projects: [project({ status: 'queued' }), project({ id: 'x', title: '競品研究', status: 'cancelled' })] });
    expect(recentModel(done)).toEqual({
      text: '相簿網站加一頁作品集',
      projects: [
        { title: '作品集頁面', status: '排隊中' },
        { title: '競品研究', status: '已取消' },
      ],
      usage: '4 回合・61 秒',
    });
  });
});

describe('送出後看哪裡 (spec Example)', () => {
  it.each([
    { from: { building: '工作樓', level: 5 }, accepted: true, to: { building: '私人樓', level: 'all' } },
    { from: { building: '工作樓', level: 'all' }, accepted: true, to: { building: '私人樓', level: 'all' } },
    { from: { building: '私人樓', level: 2 }, accepted: true, to: { building: '私人樓', level: 2 } },
    { from: { building: '工作樓', level: 5 }, accepted: false, to: { building: '工作樓', level: 5 } },
  ] as const)('$from.building $from.level，送出 $accepted → $to.building $to.level', ({ from, accepted, to }) => {
    expect(viewAfterDispatch(from, '私人樓', accepted)).toEqual(to);
  });
});

const work = (over: Partial<WorkView> = {}): WorkView => ({
  dispatch: 'd20261112-001',
  project: 'd20261112-001-1',
  title: '作品集頁面',
  status: 'waiting',
  stop: { index: 1, total: 5, level: 3, name: '需求分析組', required: false },
  rejections: 0,
  decisions: [{ id: 'w1', kind: 'question', project: 'd20261112-001-1', summary: '這頁要放幾件作品？', options: ['6 件', '12 件'] }],
  ...over,
});

describe('最近交辦的專案狀態 (spec Example)', () => {
  it.each([
    [{ status: 'queued', ahead: 1 }, '排隊中（前面還有 1 個）'],
    [{ status: 'running', at: { level: 5, name: '工程組' } }, '進行中（5F 工程組）'],
    [{ status: 'waiting' }, '等你決定'],
    [{ status: 'done' }, '已完成'],
    [{ status: 'stopped' }, '已停止'],
    [{ status: 'cancelled' }, '已取消'],
  ] as const)('%j → %s', (over, text) => {
    expect(projectStatusText(project(over as Partial<ProjectView>))).toBe(text);
  });

  it('已完成附總結；③a 的排隊說明不再出現', () => {
    const d = dispatch({ status: 'done', decisions: [], projects: [project({ status: 'done', summary: '加了作品集頁' })] });
    expect(recentModel(d).projects).toEqual([{ title: '作品集頁面', status: '已完成', summary: '加了作品集頁' }]);
    const model = drawerModel(panel(undefined, { recent: [dispatch({ status: 'done', decisions: [], projects: [project({ status: 'queued' })] })] }));
    expect(JSON.stringify(model)).not.toContain('派工引擎');
  });
});

describe('執行中區塊', () => {
  it('組員提問 (Scenario)：徽章 1，執行中區塊有問題、兩個選項', () => {
    const p = panel(undefined, { work: work() });
    expect(buttonModel(p).badge).toBe(1);
    expect(workModel(p.work)).toEqual({
      project: 'd20261112-001-1',
      line: '作品集頁面：3F 需求分析組（第 1／共 5 站）',
      waiting: true,
      cards: [{ kind: 'question', decision: 'w1', text: '這頁要放幾件作品？', options: ['6 件', '12 件'] }],
    });
  });

  it('stuck 在必經站不顯示跳過；rejected 帶 findings；blocked 只有重試', () => {
    const cards = workModel(
      work({
        stop: { index: 4, total: 5, level: 6, name: '測試品管組', required: true },
        decisions: [
          { id: 'a', kind: 'stuck', summary: '6F 測試品管組 執行失敗：組員逾時' },
          { id: 'b', kind: 'rejected', summary: '6F 第 3 次不合格：缺測試', findings: ['缺測試'] },
          { id: 'c', kind: 'blocked', summary: '「album」還沒有 speclink' },
        ],
      }),
    )!.cards;
    expect(cards).toEqual([
      { kind: 'stuck', decision: 'a', text: '6F 測試品管組 執行失敗：組員逾時', canSkip: false },
      { kind: 'rejected', decision: 'b', text: '6F 第 3 次不合格：缺測試', findings: ['缺測試'] },
      { kind: 'blocked', decision: 'c', text: '「album」還沒有 speclink' },
    ]);
    expect(workModel(work({ decisions: [{ id: 'a', kind: 'stuck', summary: 'x' }] }))!.cards[0]).toMatchObject({ canSkip: true });
  });

  it('徽章＝規劃中的決策＋執行中的決策；沒有執行中專案時沒有區塊', () => {
    expect(buttonModel(panel(dispatch(), { work: work() })).badge).toBe(2);
    expect(workModel(undefined)).toBeUndefined();
  });
});

describe('6F 檢查方式的卡片', () => {
  it('三個按鈕，英文後面用括號說明在做什麼，文字與伺服器一致', () => {
    const cards = workModel(work({ decisions: [{ id: 'q', kind: 'qa', summary: '6F 測試品管要跑哪一種檢查？' }] }))!.cards;
    expect(cards).toEqual([
      {
        kind: 'qa',
        decision: 'q',
        text: '6F 測試品管要跑哪一種檢查？',
        choices: [
          { mode: 'review', label: 'review（看程式寫得好不好：正確性、可讀性、邊界情況）' },
          { mode: 'verify', label: 'verify（看有沒有照規格做完：需求、任務、情境逐條對）' },
          { mode: 'both', label: 'review + verify（兩個都跑，最完整也最花額度）' },
        ],
      },
    ]);
    expect(cards[0].kind === 'qa' && cards[0].choices).toEqual(QA_CHOICES);
  });
});
