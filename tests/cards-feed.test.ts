import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { OfficeConfig } from '../server/src/office/config.ts';
import { createConfigSource, DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { TWO_BUILDINGS } from './fixtures/config.ts';
import { HANDOFF_WINDOW_MS, nameFor, outputToken } from '../server/src/office/feed.ts';
import { FEED_KEEP, OfficeStore } from '../server/src/office/store.ts';
import type { ActorView, OfficeEvent } from '../server/src/office/types.ts';
import { mainActorId, skillActorId, subActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';

const MIN = 60_000;
const T0 = new Date(2026, 10, 3, 10, 0, 0).getTime();
const HOME = 'D:\\home\\notes';
const WORK = 'D:\\work\\app';

function ev(sessionId: string, cwd: string, kind: OfficeEvent['kind'], extra: Partial<OfficeEvent> = {}): OfficeEvent {
  return { kind, source: 'observe', sessionId, actorId: mainActorId(sessionId), cwd, at: T0, ...extra };
}
const actor = (store: OfficeStore, id: string, now = T0 + 1, config: OfficeConfig = TWO_BUILDINGS): ActorView =>
  buildView(store, config, now).groups.flatMap((g) => g.actors).find((a) => a.id === id)!;

describe('config: names and dozing threshold', () => {
  const load = (raw: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-cfg2-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(raw));
    const warn = vi.fn<(m: string) => void>();
    const config = createConfigSource(file, { warn }).get();
    fs.rmSync(dir, { recursive: true, force: true });
    return { config, warn };
  };

  it('has 40 built-in names and a 15-minute doze threshold', () => {
    expect(DEFAULT_CONFIG.roster.names).toHaveLength(40);
    expect(new Set(DEFAULT_CONFIG.roster.names).size).toBe(40);
    expect(DEFAULT_CONFIG.timing.dozeAfterIdleMs).toBe(15 * MIN);
  });

  it('falls back to the defaults when roster.names is empty', () => {
    const { config, warn } = load({ roster: { names: [] } });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the defaults when dozeAfterIdleMs is not a positive integer', () => {
    expect(load({ timing: { dozeAfterIdleMs: 0 } }).config).toEqual(DEFAULT_CONFIG);
    expect(load({ timing: { dozeAfterIdleMs: 1.5 } }).config).toEqual(DEFAULT_CONFIG);
  });

  it('takes a custom name list', () => {
    expect(load({ roster: { names: ['甲', '乙'] } }).config.roster.names).toEqual(['甲', '乙']);
  });
});

describe('names and current task', () => {
  it('gives an actor the same name every time, and follows an edited list', () => {
    expect(nameFor('abc:main', DEFAULT_CONFIG)).toBe(nameFor('abc:main', DEFAULT_CONFIG));
    const one = { ...DEFAULT_CONFIG, roster: { ...DEFAULT_CONFIG.roster, names: ['只有我'] } };
    expect(nameFor('abc:main', one)).toBe('只有我');
  });

  // office-staff-cards spec, Scenario: 子代理卡片
  it('shows the label, the subtask description and the skill title as the task', () => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, 'turn.start'));
    store.setLabel('s', '週報整理');
    store.apply(ev('s', HOME, 'handoff.out', { actorId: subActorId('s', 't1'), subagentType: 'Explore', detail: '查本週銷售數字' }));
    store.apply(ev('s', HOME, 'actor.join', { actorId: skillActorId('s'), skill: 'speclink-review' }));
    expect(actor(store, mainActorId('s')).task).toBe('週報整理');
    const sub = actor(store, subActorId('s', 't1'));
    expect(sub).toMatchObject({ title: '資料調查員', status: 'running', task: '查本週銷售數字' });
    expect(actor(store, skillActorId('s')).task).toBe('品管工程師');
  });

  it('masks a work-building sub-agent task', () => {
    const store = new OfficeStore();
    store.apply(ev('w', WORK, 'handoff.out', { actorId: subActorId('w', 't1'), subagentType: 'Explore', detail: '找批價程式' }));
    expect(actor(store, subActorId('w', 't1')).task).toBe('處理子任務');
  });
});

describe('dozing', () => {
  // office-transcript-observer spec, Example: 狀態轉換
  it.each([
    ['turn.end', 2 * MIN + 59_000, 'done'],
    ['turn.end', 3 * MIN, 'idle'],
    ['turn.end', 17 * MIN + 59_000, 'idle'],
    ['turn.end', 18 * MIN, 'dozing'],
    ['tool.start', 10 * MIN, 'stuck'],
    ['thinking', 8 * MIN, 'stuck'],
  ] as const)('%s then %i ms → %s', (kind, elapsed, status) => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, kind, kind === 'tool.start' ? { tool: 'Bash' } : {}));
    const main = actor(store, mainActorId('s'), T0 + elapsed);
    expect(main.status).toBe(status);
    if (status === 'dozing') expect(main.bubble).toBe('打瞌睡');
  });

  it('leaves 卡住？ on turn.end and dozing on turn.start', () => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, 'tool.start', { tool: 'Bash' }));
    store.apply(ev('s', HOME, 'turn.end', { at: T0 + 11 * MIN }));
    expect(actor(store, mainActorId('s'), T0 + 11 * MIN).status).toBe('done');
    store.apply(ev('s', HOME, 'turn.start', { at: T0 + 40 * MIN }));
    expect(actor(store, mainActorId('s'), T0 + 40 * MIN).status).toBe('thinking');
  });
});

/** A session id whose main actor is named 阿哲 and whose sub-agent t1 is named 小安, as in the spec examples. */
function sessionNamed(prefix: string): string {
  for (let i = 0; i < 100_000; i++) {
    const s = `${prefix}${i}`;
    if (nameFor(mainActorId(s), DEFAULT_CONFIG) === '阿哲' && nameFor(subActorId(s, 't1'), DEFAULT_CONFIG) === '小安') return s;
  }
  throw new Error('no session id found');
}

describe('activity feed', () => {
  const feedOf = (store: OfficeStore, now = T0 + 10) => buildView(store, TWO_BUILDINGS, now).feed;

  // office-activity-feed spec, Example: 動態文字
  it.each([
    ['私人樓', HOME, '週報整理', '查本週銷售數字', '阿哲 → 小安（資料調查員）：查本週銷售數字'],
    ['工作樓', WORK, 'Billing 同群組批價更新', '找批價程式', '阿哲 → 小安（資料調查員）：派出子任務'],
  ])('writes the four kinds on the %s', (building, cwd, label, detail, handoffText) => {
    const s = sessionNamed(building === '私人樓' ? 'p' : 'w');
    const store = new OfficeStore();
    store.apply(ev(s, cwd, 'turn.start'));
    store.setLabel(s, label);
    store.apply(ev(s, cwd, 'tool.start', { tool: 'AskUserQuestion', toolUseId: 'q', at: T0 + 1 }));
    store.apply(ev(s, cwd, 'tool.end', { toolUseId: 'q', at: T0 + 2 }));
    store.apply(ev(s, cwd, 'handoff.out', { actorId: subActorId(s, 't1'), subagentType: 'Explore', detail, at: T0 + 3 }));
    store.apply(ev(s, cwd, 'handoff.back', { actorId: subActorId(s, 't1'), at: T0 + 4 }));
    store.apply(ev(s, cwd, 'turn.end', { at: T0 + 5 }));
    const feed = feedOf(store);
    expect(feed.map((f) => [f.kind, f.text, f.building])).toEqual([
      ['done', `阿哲 完成：${label}`, building],
      ['return', '小安（資料調查員）→ 阿哲 交回', building],
      ['handoff', handoffText, building],
      ['waiting', `阿哲 等你：${label}`, building],
    ]);
    // The label stays visible by the user's decision; the subtask description must not.
    if (building === '工作樓') expect(JSON.stringify(buildView(store, TWO_BUILDINGS, T0 + 10))).not.toContain(detail);
  });

  // office-activity-feed spec, Scenario: 等你只記一次
  it('records one waiting per stretch of waiting', () => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, 'tool.start', { tool: 'AskUserQuestion', toolUseId: 'q' }));
    store.apply(ev('s', HOME, 'waiting', { source: 'hook', at: T0 + 1 }));
    store.apply(ev('s', HOME, 'tool.end', { toolUseId: 'q', at: T0 + 2 }));
    expect(feedOf(store).filter((f) => f.kind === 'waiting')).toHaveLength(1);
  });

  it('keeps the latest 100 records and shows 30', () => {
    const store = new OfficeStore();
    for (let i = 0; i < FEED_KEEP + 1; i++) store.apply(ev('s', HOME, 'turn.end', { at: T0 + i }));
    expect(store.feed).toHaveLength(FEED_KEEP);
    expect(store.feed[0].at).toBe(T0 + 1);
    const feed = feedOf(store, T0 + 1000);
    expect(feed).toHaveLength(30);
    expect(feed[0].at).toBe(T0 + FEED_KEEP);
  });
});

describe('hand-offs for the arcs', () => {
  // office-handoff-arcs spec, Scenario: 交接過期
  it('keeps a hand-off for 15 seconds', () => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, 'handoff.out', { actorId: subActorId('s', 't1'), subagentType: 'Explore' }));
    const at = (ms: number) => buildView(store, TWO_BUILDINGS, T0 + ms).handoffs;
    expect(at(14_000)).toHaveLength(1);
    expect(at(HANDOFF_WINDOW_MS)).toHaveLength(0);
    expect(at(14_000)[0]).toMatchObject({ from: mainActorId('s'), to: subActorId('s', 't1') });
  });

  it('points a return back to the main actor', () => {
    const store = new OfficeStore();
    store.apply(ev('s', HOME, 'handoff.out', { actorId: subActorId('s', 't1') }));
    store.apply(ev('s', HOME, 'handoff.back', { actorId: subActorId('s', 't1'), at: T0 + 1 }));
    const back = buildView(store, TWO_BUILDINGS, T0 + 2).handoffs[1];
    expect(back).toMatchObject({ from: subActorId('s', 't1'), to: mainActorId('s') });
  });
});

describe('outputs on the main card', () => {
  // office-staff-cards spec, Scenario: 工作樓產出
  it('gives a work-building card only a count', () => {
    const store = new OfficeStore();
    store.apply(ev('w', WORK, 'output.add', { tool: 'Edit', detail: 'D:\\work\\app\\Billing.pas' }));
    const main = actor(store, mainActorId('w'));
    expect(main.outputCount).toBe(1);
    expect(main.outputs).toBeUndefined();
    expect(JSON.stringify(buildView(store, TWO_BUILDINGS, T0 + 1))).not.toContain('Billing');
  });

  // office-staff-cards spec, Scenario: 私人樓多個產出
  it('lists private outputs newest first, once per file, with tokens instead of paths', () => {
    const store = new OfficeStore();
    const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    files.forEach((f, i) => store.apply(ev('s', HOME, 'output.add', { detail: `${HOME}\\${f}`, at: T0 + i })));
    // c.md written again last: it moves to the front and still counts once.
    store.apply(ev('s', HOME, 'output.add', { detail: `${HOME}\\c.md`, at: T0 + 5 }));
    const main = actor(store, mainActorId('s'), T0 + 10);
    expect(main.outputCount).toBe(5);
    expect(main.outputs!.map((o) => o.name)).toEqual(['c.md', 'e.md', 'd.md', 'b.md', 'a.md']);
    expect(main.outputs![0].token).toBe(outputToken('s', `${HOME}\\c.md`));
    expect(JSON.stringify(main)).not.toContain('home');
  });
});

describe('progress shown on the cards', () => {
  const setup = (cwd: string, known: boolean) => {
    const store = new OfficeStore();
    store.apply(ev('s', cwd, 'turn.start'));
    if (known) store.apply(ev('s', cwd, 'progress', { progress: { done: 3, total: 8 } }));
    store.apply(ev('s', cwd, 'actor.join', { actorId: skillActorId('s'), skill: 'speclink-apply' }));
    store.apply(ev('s', cwd, 'tool.start', { tool: 'Bash', toolUseId: 'b' }));
    store.apply(ev('s', cwd, 'handoff.out', { actorId: subActorId('s', 't1') }));
    return store;
  };

  // office-staff-cards spec, Example: 進度顯示
  it.each([
    ['私人樓', true, 'main', 'done', { done: 3, total: 8 }],
    ['私人樓', true, 'skill', 'running', { done: 3, total: 8 }],
    ['私人樓', true, 'sub', 'running', 'indeterminate'],
    ['私人樓', false, 'main', 'thinking', 'indeterminate'],
    ['工作樓', false, 'main', 'running', 'indeterminate'],
    ['工作樓', false, 'main', 'idle', undefined],
  ] as const)('%s, known=%s, %s %s → %j', (building, known, who, status, expected) => {
    const store = setup(building === '私人樓' ? HOME : WORK, known);
    let now = T0 + 1;
    if (status === 'done') store.apply(ev('s', HOME, 'turn.end', { at: T0 + 1 }));
    if (status === 'thinking') store.apply(ev('s', HOME, 'tool.end', { toolUseId: 'b', at: T0 + 1 }));
    if (status === 'idle') {
      store.apply(ev('s', WORK, 'turn.end', { at: T0 + 1 }));
      now = T0 + 4 * MIN;
    }
    const id = who === 'main' ? mainActorId('s') : who === 'skill' ? skillActorId('s') : subActorId('s', 't1');
    const view = actor(store, id, now);
    expect(view.status).toBe(status === 'thinking' && who === 'main' ? 'thinking' : view.status);
    expect(view.progress).toEqual(expected);
  });

  it('clears a known ratio on a progress event without one', () => {
    const store = setup(HOME, true);
    store.apply(ev('s', HOME, 'progress', { at: T0 + 1 }));
    expect(actor(store, mainActorId('s'), T0 + 2).progress).toBe('indeterminate');
  });
});
