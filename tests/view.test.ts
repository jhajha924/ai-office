import { describe, expect, it } from 'vitest';

import { TWO_BUILDINGS } from './fixtures/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import type { OfficeEvent, OfficeEventSource } from '../server/src/office/types.ts';
import { mainActorId, subActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';

const config = TWO_BUILDINGS;
const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime();

function ev(sessionId: string, cwd: string, kind: OfficeEvent['kind'], extra: Partial<OfficeEvent> = {}): OfficeEvent {
  return { kind, source: 'observe', sessionId, actorId: mainActorId(sessionId), cwd, at: T0, ...extra };
}

describe('the OfficeEvent seam', () => {
  // office-event-stream spec, Scenario: 示範來源與真實來源畫面一致
  it('gives the same group content whatever the source', () => {
    const run = (source: OfficeEventSource, sessionId: string) => {
      const store = new OfficeStore();
      const cwd = 'D:\\home\\notes';
      store.apply(ev(sessionId, cwd, 'turn.start', { source }));
      store.apply(ev(sessionId, cwd, 'tool.start', { source, tool: 'Read', detail: 'D:\\home\\notes\\a.md', at: T0 + 1 }));
      store.apply(ev(sessionId, cwd, 'turn.end', { source, at: T0 + 2 }));
      const group = buildView(store, config, T0 + 3).groups[0];
      // Ids, and what derives from them (name, label placeholder, task), differ by design.
      return { ...group, sessionId: 'x', label: 'x', actors: group.actors.map((a) => ({ ...a, id: 'x', name: 'x', task: 'x' })) };
    };
    expect(run('demo', 'aaaa1111')).toEqual(run('observe', 'bbbb2222'));
  });
});

describe('processing station', () => {
  // office-event-stream spec, Scenario: 工作樓讀檔
  it('masks a work-building file read before it leaves the server', () => {
    const store = new OfficeStore();
    store.apply(ev('w1', 'D:\\work\\app', 'tool.start', { tool: 'Read', detail: 'D:\\work\\app\\Billing.pas' }));
    const view = buildView(store, config, T0 + 1);
    const text = JSON.stringify(view);
    expect(text).not.toContain('Billing');
    expect(text).not.toContain('app');
    expect(view.groups[0].building).toBe('工作樓');
    expect(view.groups[0].actors[0].bubble).toBe('讀取檔案');
  });

  // office-event-stream spec, Scenario: 私人樓只顯示檔名
  it('shows only the file name on the private building', () => {
    const store = new OfficeStore();
    store.apply(ev('p1', 'D:\\home\\notes', 'tool.start', { tool: 'Read', detail: 'D:\\home\\notes\\proposal.md' }));
    const view = buildView(store, config, T0 + 1);
    expect(view.groups[0].actors[0].bubble).toBe('讀取 proposal.md');
    expect(JSON.stringify(view)).not.toContain('home');
  });

  it('masks a work-building sub-agent description', () => {
    const store = new OfficeStore();
    const sub = subActorId('w2', 'toolu_1');
    store.apply(ev('w2', 'D:\\work\\app', 'handoff.out', { actorId: sub, subagentType: 'Explore', detail: '找批價程式' }));
    const view = buildView(store, config, T0 + 1);
    const actor = view.groups[0].actors.find((a) => a.id === sub)!;
    expect(actor.title).toBe('資料調查員');
    expect(actor.bubble).toBe('處理子任務');
    expect(JSON.stringify(view)).not.toContain('批價');
  });
});

describe('building stats', () => {
  const work = 'D:\\work\\app';

  // office-session-groups spec, Scenario: 一個對話卡在等核准 / 核准後更新
  it('counts working and waiting main characters only', () => {
    const store = new OfficeStore();
    store.apply(ev('a', work, 'tool.start', { tool: 'Bash', detail: 'x' }));
    store.apply(ev('b', work, 'thinking'));
    store.apply(ev('c', work, 'tool.start', { tool: 'Bash' }));
    store.apply(ev('c', work, 'waiting', { source: 'hook' }));
    store.apply(ev('a', work, 'handoff.out', { actorId: subActorId('a', 't1'), subagentType: 'Explore' }));
    let stats = buildView(store, config, T0 + 1).buildings.find((f) => f.name === '工作樓')!.stats;
    expect(stats).toMatchObject({ working: 2, waiting: 1 });

    store.apply(ev('c', work, 'tool.end', { at: T0 + 2 }));
    stats = buildView(store, config, T0 + 3).buildings.find((f) => f.name === '工作樓')!.stats;
    expect(stats).toMatchObject({ working: 3, waiting: 0 });
  });

  // office-session-groups spec, Example: 產出計數
  it.each([
    [[['a.md', 0], ['b.md', 0]], 2],
    [[['a.md', 0], ['a.md', 0], ['b.md', 0]], 2],
    [[['c.md', -60_000 * 601], ['a.md', 0]], 1],
  ] as [Array<[string, number]>, number][])('counts distinct files written today: %j → %i', (files, expected) => {
    // T0 is 10:00, so -601 minutes is yesterday 23:59.
    const store = new OfficeStore();
    for (const [file, offset] of files) {
      store.apply(ev('o', 'D:\\home\\x', 'output.add', { tool: 'Write', detail: `D:\\home\\x\\${file}`, at: T0 + offset }));
    }
    const stats = buildView(store, config, T0 + 1).buildings.find((f) => f.name === '私人樓')!.stats;
    expect(stats.outputs).toBe(expected);
  });

  it('lists both buildings even when empty', () => {
    expect(buildView(new OfficeStore(), config, T0).buildings.map((f) => f.name)).toEqual(['工作樓', '私人樓']);
  });
});

describe('skill employees', () => {
  const cwd = 'D:/home/x';
  const skillOf = (store: OfficeStore, now: number) =>
    buildView(store, config, now).groups[0].actors.filter((a) => a.role === 'skill');

  // office-staff-roster spec, Scenario: 叫用審查 Skill
  it('brings in a titled employee that shows the main session tool work', () => {
    const store = new OfficeStore();
    store.apply(ev('s', cwd, 'tool.start', { tool: 'Skill', toolUseId: 't1' }));
    store.apply(ev('s', cwd, 'actor.join', { skill: 'speclink-review' }));
    store.apply(ev('s', cwd, 'tool.end', { toolUseId: 't1', at: T0 + 1 }));
    store.apply(ev('s', cwd, 'tool.start', { tool: 'Read', detail: 'D:/home/x/a.md', at: T0 + 2 }));
    const [skill] = skillOf(store, T0 + 3);
    expect(skill.title).toBe('品管工程師');
    expect(skill.bubble).toBe('讀取 a.md');
    expect(skill.tool).toBe('Read');
    const main = buildView(store, config, T0 + 3).groups[0].actors[0];
    expect(main.bubble).toBe('交給 品管工程師');
  });

  // office-staff-roster spec, Scenario: 回合結束後離開
  it('leaves when the turn ends', () => {
    const store = new OfficeStore();
    store.apply(ev('s', cwd, 'actor.join', { skill: 'speclink-review' }));
    store.apply(ev('s', cwd, 'turn.end', { at: T0 + 1 }));
    expect(skillOf(store, T0 + 2)).toHaveLength(0);
  });

  // office-staff-roster spec, Scenario: 連續叫用兩個 Skill
  it('is replaced by the next skill, one per session', () => {
    const store = new OfficeStore();
    store.apply(ev('s', cwd, 'actor.join', { skill: 'speclink-propose' }));
    store.apply(ev('s', cwd, 'actor.join', { skill: 'speclink-review', at: T0 + 1 }));
    const skills = skillOf(store, T0 + 2);
    expect(skills.map((s) => s.title)).toEqual(['品管工程師']);
  });
});
