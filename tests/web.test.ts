import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ActorView, FeedEntryView, HandoffView } from '../server/src/office/types.ts';
import { arcPath, newArcs } from '../web/src/arcs.ts';
import { cardModel, STATUS_TEXT } from '../web/src/cards.ts';
import { feedItems } from '../web/src/feed.ts';
import { hourFromQuery, phaseAt } from '../web/src/scene/daylight.ts';
import { choosePoi, dwellMs } from '../web/src/scene/idleLife.ts';
import { blockedCells, cellKey, DOOR, PING_PONG, PODS, POIS } from '../web/src/scene/layout.ts';
import { findPath } from '../web/src/scene/pathfinding.ts';
import { TEXT } from '../web/src/text.ts';
import { pickFloor, showTabs } from '../web/src/ui.ts';

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
  it('shows only "N 個檔案" on a masked floor', () => {
    const m = cardModel(actor({ outputCount: 1 }));
    expect(m.tags).toEqual([]);
    expect(m.countText).toBe('1 個檔案');
  });
});

describe('floor choice and tabs', () => {
  // office-3d-scene spec, Example: 選擇要顯示的樓層
  it.each([
    [undefined, ['辦公室'], '辦公室', false],
    ['私人樓', ['工作樓', '私人樓'], '私人樓', true],
    ['私人樓', ['辦公室'], '辦公室', false],
    [undefined, ['工作樓', '私人樓'], '工作樓', true],
  ] as const)('remembered %s, floors %j → shows %s, tabs %s', (saved, floors, shown, tabs) => {
    expect(pickFloor(saved, [...floors])).toBe(shown);
    expect(showTabs([...floors])).toBe(tabs);
  });

  it('finds every data-text and data-text-label key of index.html as a plain string in TEXT', () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf-8');
    const keys = [...html.matchAll(/data-text(?:-label)?="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(typeof (TEXT as Record<string, unknown>)[key], key).toBe('string');
  });

  it('never names a floor itself', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'main.ts'), 'utf-8');
    expect(source).not.toMatch(/私人樓|工作樓/);
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

  const h = (id: string, floor = '私人樓'): HandoffView => ({ id, at: 0, floor, from: 's:main', to: 's:sub:t1', label: 'x' });

  it('draws each hand-off once, only on its floor and only with both cards on screen', () => {
    const drawn = new Set<string>();
    const boxes = (id: string) => (id === 's:main' ? a : id === 's:sub:t1' ? b : undefined);
    expect(newArcs([h('f1'), h('f2', '工作樓')], '私人樓', drawn, boxes).map((x) => x.id)).toEqual(['f1']);
    expect(newArcs([h('f1')], '私人樓', drawn, boxes)).toEqual([]);
    expect(newArcs([h('f3')], '私人樓', drawn, () => undefined)).toEqual([]);
    expect(drawn.has('f3')).toBe(false);
  });
});

describe('feed items', () => {
  const entry = (i: number, floor: string): FeedEntryView => ({
    id: `f${i}`,
    at: new Date(2026, 10, 3, 9, i % 60, 0).getTime(),
    floor,
    kind: 'done',
    text: `第 ${i} 則`,
  });

  // office-activity-feed spec, Scenario: 別的樓層的動態
  it('keeps this floor only, in order, at most 30, with HH:MM', () => {
    const feed = [entry(40, '工作樓'), ...Array.from({ length: 35 }, (_, i) => entry(35 - i, '私人樓'))];
    const items = feedItems(feed, '私人樓');
    expect(items).toHaveLength(30);
    expect(items[0]).toMatchObject({ id: 'f35', time: '09:35', text: '第 35 則' });
    expect(items.every((i) => i.id !== 'f40')).toBe(true);
    expect(feedItems(feed, '工作樓').map((i) => i.time)).toEqual(['09:40']);
  });
});

describe('idle life', () => {
  const blocked = blockedCells();

  it('builds the ping-pong table on blocked cells', () => {
    expect(blocked.has(cellKey(PING_PONG))).toBe(true);
    expect(blocked.has(cellKey({ x: PING_PONG.x + 1, z: PING_PONG.z }))).toBe(true);
  });

  it('can reach every point of interest from the door and every seat without crossing furniture', () => {
    const starts = [DOOR, ...PODS.flatMap((p) => p.seats)];
    for (const poi of POIS) {
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
