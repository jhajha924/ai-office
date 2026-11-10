import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ActorView, FeedEntryView, HandoffView, LevelView, OfficeView } from '../server/src/office/types.ts';
import { arcPath, newArcs } from '../web/src/arcs.ts';
import { boardContent } from '../web/src/board.ts';
import { cardModel, STATUS_TEXT } from '../web/src/cards.ts';
import { feedItems } from '../web/src/feed.ts';
import { hourFromQuery, phaseAt } from '../web/src/scene/daylight.ts';
import { choosePoi, dwellMs } from '../web/src/scene/idleLife.ts';
import { levelSummary, levelTag, overviewTagText, pickLevel, roomName } from '../web/src/levels.ts';
import { blockedCells, PLANS } from '../web/src/scene/floorPlans.ts';
import { cellKey, DOOR, ELEVATOR } from '../web/src/scene/layout.ts';
import { findPath } from '../web/src/scene/pathfinding.ts';
import { TEXT } from '../web/src/text.ts';
import { pickBuilding, showTabs } from '../web/src/ui.ts';

const actor = (over: Partial<ActorView> = {}): ActorView => ({
  id: 's:main',
  role: 'main',
  title: '主對話',
  model: 'opus',
  status: 'running',
  bubble: '',
  since: 0,
  name: '阿哲',
  task: '週報整理',
  ...over,
});

describe('card model', () => {
  // office-staff-cards spec, Example: 狀態文字
  it.each([
    ['idle-new', '待命'],
    ['thinking', '思考中'],
    ['running', '執行中'],
    ['replying', '回覆中'],
    ['done', '已完成'],
    ['waiting', '等你'],
    ['stuck', '卡住？'],
    ['idle', '閒置'],
    ['dozing', '打瞌睡'],
  ] as const)('%s → %s', (status, text) => {
    expect(STATUS_TEXT[status]).toBe(text);
    expect(cardModel(actor({ status })).statusText).toBe(text);
  });

  it('shows name, initial, title, task and the model letter', () => {
    expect(cardModel(actor())).toMatchObject({ initial: '阿', name: '阿哲', title: '主對話', task: '週報整理', modelLetter: 'O' });
  });

  it('turns progress into a ratio bar, an indeterminate bar, or none', () => {
    expect(cardModel(actor({ progress: { done: 3, total: 8 } })).progress).toEqual({ kind: 'ratio', done: 3, total: 8, percent: 37.5 });
    expect(cardModel(actor({ progress: 'indeterminate' })).progress).toEqual({ kind: 'indeterminate' });
    expect(cardModel(actor()).progress).toBeUndefined();
  });

  // office-staff-cards spec, Scenario: 私人樓多個產出
  it('shows three output tags and "+N" for the rest', () => {
    const outputs = ['e.md', 'd.md', 'c.md', 'b.md', 'a.md'].map((name, i) => ({ token: `t${i}`, name }));
    const m = cardModel(actor({ outputs, outputCount: 5 }));
    expect(m.tags.map((t) => t.name)).toEqual(['e.md', 'd.md', 'c.md']);
    expect(m.more).toBe(2);
    expect(m.countText).toBeUndefined();
  });

  // office-staff-cards spec, Scenario: 工作樓產出
  it('shows only "N 個檔案" on a masked building', () => {
    const m = cardModel(actor({ outputCount: 1 }));
    expect(m.tags).toEqual([]);
    expect(m.countText).toBe('1 個檔案');
  });
});

describe('building choice and tabs', () => {
  // office-3d-scene spec, Example: 選擇要顯示的樓層
  it.each([
    [undefined, ['辦公室'], '辦公室', false],
    ['私人樓', ['工作樓', '私人樓'], '私人樓', true],
    ['私人樓', ['辦公室'], '辦公室', false],
    [undefined, ['工作樓', '私人樓'], '工作樓', true],
  ] as const)('remembered %s, buildings %j → shows %s, tabs %s', (saved, buildings, shown, tabs) => {
    expect(pickBuilding(saved, [...buildings])).toBe(shown);
    expect(showTabs([...buildings])).toBe(tabs);
  });

  it('finds every data-text and data-text-label key of index.html as a plain string in TEXT', () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf-8');
    const keys = [...html.matchAll(/data-text(?:-label)?="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(typeof (TEXT as Record<string, unknown>)[key], key).toBe('string');
  });

  it('never names a building itself', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'main.ts'), 'utf-8');
    expect(source).not.toMatch(/私人樓|工作樓/);
  });
});

describe('floors in a building', () => {
  const levels = (occupied: number[], all = [1, 2, 3, 4, 5, 6, 7]): LevelView[] =>
    all.map((level) => ({ level, name: `${level}`, kind: level === 1 ? 'lobby' : level === 2 ? 'managers' : 'department', theme: level === 1 ? 'lobby' : level === 2 ? 'managers' : 'build', groups: occupied.includes(level) ? 1 : 0 }));

  // office-building-floors spec, Example: 選擇要顯示的樓層
  it.each([
    [undefined, 'all'],
    ['all', 'all'],
    [6, 6],
    [9, 'all'],
  ] as const)('remembered %s, floors 1–7 → shows %s', (saved, shown) => {
    expect(pickLevel(saved, levels([5]))).toBe(shown);
  });

  // office-building-floors spec, Requirement: 整棟視圖 (name plates show the status word, never tools, files or commands)
  it.each([
    [{ status: 'running', bubble: '執行指令：npm run build', tool: 'Bash' }, '執行中'],
    [{ status: 'waiting', bubble: '等你核准', tool: undefined }, '等你'],
    [{ status: 'dozing', bubble: '打瞌睡', tool: undefined }, '打瞌睡'],
  ] as const)('shows %j as %s in the whole-building view', (over, text) => {
    const shown = overviewTagText(actor({ ...over }));
    expect(shown).toBe(text);
    expect(shown).not.toMatch(/npm|Bash|build/);
  });

  it('labels a floor as 5F and the whole building as 整棟', () => {
    expect(levelTag(5)).toBe('5F');
    expect(levelTag('all')).toBe('整棟');
  });

  // office-building-floors spec, Example: 樓板標籤與邊框
  it.each([
    [[], '5F 工程組｜0 組｜工作中 0・等你 0', undefined],
    [['running', 'waiting'], '5F 工程組｜2 組｜工作中 1・等你 1', 'waiting'],
    [['stuck', 'waiting'], '5F 工程組｜2 組｜工作中 0・等你 1', 'stuck'],
    [['thinking', 'done'], '5F 工程組｜2 組｜工作中 1・等你 0', undefined],
  ] as const)('main characters %j → %s, edge %s', (statuses, label, alert) => {
    const view: OfficeView = {
      buildings: [{ name: '工作樓', masked: true, stats: { working: 0, outputs: 0, waiting: 0 }, levels: [{ level: 5, name: '工程組', kind: 'department', departmentId: 'build', theme: 'build', groups: statuses.length }] }],
      groups: statuses.map((status, i) => ({
        sessionId: `s${i}`,
        building: '工作樓',
        level: 5,
        label: `g${i}`,
        lastActivity: 0,
        actors: [actor({ id: `s${i}:main`, status }), actor({ id: `s${i}:sub:t`, role: 'subagent', status: 'running' })],
      })),
      feed: [],
      handoffs: [],
      generatedAt: 0,
    };
    const summary = levelSummary(view, '工作樓', 5);
    expect(summary.label).toBe(label);
    expect(summary.alert).toBe(alert);
  });

  // office-3d-scene spec, Example: 房間名稱
  it.each([
    ['lobby', '總裁室'],
    ['managers', '主管會議室'],
    ['department', '組長室'],
  ] as const)('names the room on a %s floor %s', (kind, name) => {
    expect(roomName(kind)).toBe(name);
  });

  // office-building-floors spec, Requirement: 員工搭電梯換樓層
  it.each(Object.values(PLANS))('puts the elevator on a free cell next to the door on $theme, reachable from every seat and point of interest', (plan) => {
    const blocked = blockedCells(plan);
    expect(blocked.has(cellKey(ELEVATOR))).toBe(false);
    expect(Math.abs(ELEVATOR.x - DOOR.x) + Math.abs(ELEVATOR.z - DOOR.z)).toBe(1);
    const targets = [...plan.pods.flatMap((p) => p.seats), ...plan.pois, DOOR];
    for (const target of targets) {
      const path = findPath(ELEVATOR, target, blocked);
      expect(path[path.length - 1], cellKey(target)).toEqual({ x: target.x, z: target.z });
      const back = findPath(target, ELEVATOR, blocked);
      expect(back[back.length - 1]).toEqual({ x: ELEVATOR.x, z: ELEVATOR.z });
    }
  });

  it('shows the floor buttons and a floor tag on sidebar rows: index.html has the levels panel', () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf-8');
    expect(html).toContain('id="levels"');
  });
});

describe('hand-off arcs', () => {
  const a = { left: 100, top: 500, width: 200 };
  const b = { left: 420, top: 500, width: 200 };

  it('runs from the top middle of one card to the top middle of the other, bowing upwards', () => {
    const g = arcPath(a, b);
    expect(g.start).toEqual({ x: 200, y: 500 });
    expect(g.end).toEqual({ x: 520, y: 500 });
    expect(g.control.x).toBe(360);
    expect(g.control.y).toBeLessThan(500);
    expect(g.apex.y).toBeLessThan(500);
    expect(g.d).toBe(`M 200 500 Q 360 ${g.control.y} 520 500`);
  });

  const h = (id: string, building = '私人樓'): HandoffView => ({ id, at: 0, building, from: 's:main', to: 's:sub:t1', label: 'x' });

  it('draws each hand-off once, only on its building and only with both cards on screen', () => {
    const drawn = new Set<string>();
    const boxes = (id: string) => (id === 's:main' ? a : id === 's:sub:t1' ? b : undefined);
    expect(newArcs([h('f1'), h('f2', '工作樓')], '私人樓', drawn, boxes).map((x) => x.id)).toEqual(['f1']);
    expect(newArcs([h('f1')], '私人樓', drawn, boxes)).toEqual([]);
    expect(newArcs([h('f3')], '私人樓', drawn, () => undefined)).toEqual([]);
    expect(drawn.has('f3')).toBe(false);
  });
});

describe('war-room board', () => {
  const group = (label: string, level: number, status: ActorView['status'], lastActivity: number, building = '私人樓') => ({
    sessionId: label,
    building,
    level,
    label,
    lastActivity,
    actors: [actor({ id: `${label}:main`, status }), actor({ id: `${label}:sub:t`, role: 'subagent', status: 'stuck' })],
  });
  const view = (groups: OfficeView['groups'], feed: FeedEntryView[] = []): OfficeView => ({ buildings: [], groups, feed, handoffs: [], generatedAt: 0 });
  const columns = (v: OfficeView) => boardContent(v, '私人樓').columns.map((c) => [c.title, c.items]);

  // office-building-floors spec, Example: 看板內容
  it('says （無） in every column of an empty building', () => {
    expect(columns(view([]))).toEqual([
      ['待你決議 0', ['（無）']],
      ['卡住 0', ['（無）']],
      ['最新動態 0', ['（無）']],
    ]);
  });

  it('lists a waiting group and a stuck one by floor, counting main characters only, this building only', () => {
    const v = view([group('A', 5, 'waiting', 2), group('B', 6, 'stuck', 1), group('C', 5, 'running', 3), group('D', 5, 'waiting', 9, '工作樓')]);
    const [decide, stuck] = columns(v);
    expect(decide).toEqual(['待你決議 1', ['5F A']]);
    expect(stuck).toEqual(['卡住 1', ['6F B']]);
  });

  it('shows the newest 6 of 8 feed lines with their category', () => {
    const kinds = ['done', 'handoff', 'return', 'waiting'] as const;
    const feed: FeedEntryView[] = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, at: i, building: '私人樓', kind: kinds[i % 4], text: `第 ${i} 則` }));
    feed.push({ id: 'x', at: 99, building: '工作樓', kind: 'done', text: '別棟' });
    const [, , latest] = columns(view([], feed));
    expect(latest).toEqual(['最新動態 6', ['等你 第 7 則', '回報 第 6 則', '交辦 第 5 則', '完成 第 4 則', '等你 第 3 則', '回報 第 2 則']]);
    expect(boardContent(view([], [{ id: 'd', at: 1, building: '私人樓', kind: 'done', text: '本週銷售週報 產出 1 個檔案' }]), '私人樓').columns[2].items).toEqual([
      '完成 本週銷售週報 產出 1 個檔案',
    ]);
  });

  it('keeps the most recent groups first and at most 6 per column', () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`G${i}`, 3, 'waiting', i));
    const [decide] = columns(view(groups));
    expect(decide[0]).toBe('待你決議 8');
    expect(decide[1]).toEqual(['3F G7', '3F G6', '3F G5', '3F G4', '3F G3', '3F G2']);
  });
});

describe('feed items', () => {
  const entry = (i: number, building: string): FeedEntryView => ({
    id: `f${i}`,
    at: new Date(2026, 10, 3, 9, i % 60, 0).getTime(),
    building,
    kind: 'done',
    text: `第 ${i} 則`,
  });

  // office-activity-feed spec, Scenario: 別的樓層的動態
  it('keeps this building only, in order, at most 30, with HH:MM', () => {
    const feed = [entry(40, '工作樓'), ...Array.from({ length: 35 }, (_, i) => entry(35 - i, '私人樓'))];
    const items = feedItems(feed, '私人樓');
    expect(items).toHaveLength(30);
    expect(items[0]).toMatchObject({ id: 'f35', time: '09:35', text: '第 35 則' });
    expect(items.every((i) => i.id !== 'f40')).toBe(true);
    expect(feedItems(feed, '工作樓').map((i) => i.time)).toEqual(['09:40']);
  });
});

describe('idle life', () => {
  // The managers' floor keeps the original pantry and lounge.
  const plan = PLANS.managers;
  const POIS = plan.pois;
  const blocked = blockedCells(plan);
  const pingPong = plan.props.find((p) => p.kind === 'pingPong')!;

  it('builds the ping-pong table on blocked cells', () => {
    expect(blocked.has(cellKey(pingPong))).toBe(true);
    expect(blocked.has(cellKey({ x: pingPong.x + 1, z: pingPong.z }))).toBe(true);
  });

  it.each(Object.values(PLANS))('can reach every point of interest on $theme from the door and every seat without crossing furniture', (floor) => {
    const blocked = blockedCells(floor);
    const starts = [DOOR, ...floor.pods.flatMap((p) => p.seats)];
    for (const poi of floor.pois) {
      expect(blocked.has(cellKey(poi)), poi.name).toBe(false);
      for (const start of starts) {
        const path = findPath(start, poi, blocked);
        expect(path[path.length - 1]).toEqual({ x: poi.x, z: poi.z });
        for (const step of path.slice(1, -1)) expect(blocked.has(cellKey(step)), `${poi.name} ${cellKey(step)}`).toBe(false);
        for (let i = 1; i < path.length; i++) {
          expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z)).toBe(1);
        }
      }
    }
  });

  it('covers the pantry, the ping-pong table and the lounge', () => {
    const names = POIS.map((p) => p.name).join(' ');
    for (const word of ['咖啡機', '微波爐', '吧檯', '桌球桌', '沙發', '書櫃']) expect(names).toContain(word);
  });

  it('never picks an occupied point, and picks none when all are taken', () => {
    const occupied = new Set(POIS.slice(1).map(cellKey));
    expect(choosePoi(POIS, occupied, () => 0.99)).toEqual(POIS[0]);
    expect(choosePoi(POIS, new Set(POIS.map(cellKey)))).toBeUndefined();
  });

  it('stays 20 to 40 seconds', () => {
    expect(dwellMs(() => 0)).toBe(20_000);
    expect(dwellMs(() => 0.999999)).toBe(40_000);
  });
});

describe('day and night', () => {
  // office-3d-scene spec, Example: 時段
  it.each([
    [6, 'night'],
    [7, 'day'],
    [16, 'day'],
    [17, 'dusk'],
    [18, 'dusk'],
    [19, 'night'],
  ] as const)('%i:00 → %s', (hour, phase) => {
    expect(phaseAt(hour)).toBe(phase);
  });

  it('pins the hour only for an integer 0–23', () => {
    expect(hourFromQuery('?hour=21')).toBe(21);
    expect(hourFromQuery('?hour=0')).toBe(0);
    for (const bad of ['?hour=24', '?hour=-1', '?hour=7.5', '?hour=abc', '?hour=', '']) expect(hourFromQuery(bad)).toBeUndefined();
  });
});
