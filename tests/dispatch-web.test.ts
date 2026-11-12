import { describe, expect, it } from 'vitest';

import type { DispatchPanelView, DispatchView, ProjectView } from '../server/src/office/types.ts';
import { buttonModel, confirmCards, drawerModel, QUEUED_HINT, recentModel, routeToStart, viewAfterDispatch } from '../web/src/dispatch.ts';

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
        { title: '作品集頁面', status: '排隊中（等派工引擎）' },
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

describe('開工後的說明 (Scenario)', () => {
  it('最近交辦有排隊中的專案 → 標題下方顯示說明', () => {
    const done = dispatch({ status: 'done', decisions: [], projects: [project({ status: 'queued' })] });
    const model = drawerModel(panel(undefined, { recent: [done] }));
    expect(model.kind === 'form' && model.hint).toBe('排隊中的專案要等下一版的派工引擎才會開工，目前 3F～7F 不會有人上工。');
    expect(QUEUED_HINT).toBe('排隊中的專案要等下一版的派工引擎才會開工，目前 3F～7F 不會有人上工。');
  });

  it('只有已取消的專案 → 不顯示', () => {
    const done = dispatch({ status: 'done', decisions: [], projects: [project({ status: 'cancelled' })] });
    const model = drawerModel(panel(undefined, { recent: [done] }));
    expect(model.kind === 'form' && model.hint).toBeUndefined();
  });

  it('沒有最近交辦 → 不顯示', () => {
    expect(drawerModel(panel())).toEqual({ kind: 'form', building: '私人樓', recent: [] });
  });
});
