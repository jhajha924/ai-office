import { describe, expect, it } from 'vitest';

import { TWO_FLOORS } from './fixtures/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import type { OfficeEvent } from '../server/src/office/types.ts';
import { mainActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';

const config = TWO_FLOORS;
const MIN = 60_000;
const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime();
const cwd = 'D:/home/x';

function ev(kind: OfficeEvent['kind'], at: number, extra: Partial<OfficeEvent> = {}): OfficeEvent {
  return { kind, source: 'observe', sessionId: 's', actorId: mainActorId('s'), cwd, at, ...extra };
}
const mainAt = (store: OfficeStore, now: number) => buildView(store, config, now).groups[0].actors[0];

describe('employee state over time', () => {
  // office-transcript-observer spec, Example: 狀態轉換
  it.each([
    ['turn.end', 2 * MIN + 59_000, 'done'],
    ['turn.end', 3 * MIN, 'idle'],
    ['tool.start', 10 * MIN, 'stuck'],
    ['tool.start', 10 * MIN - 1, 'running'],
    ['thinking', 8 * MIN, 'stuck'],
  ] as const)('%s then %i ms of silence → %s', (kind, elapsed, status) => {
    const store = new OfficeStore();
    store.apply(ev(kind, T0, kind === 'tool.start' ? { tool: 'Bash' } : {}));
    expect(mainAt(store, T0 + elapsed).status).toBe(status);
  });

  it('leaves 卡住？ on the next event', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Bash', detail: 'npm run build' }));
    const stuck = mainAt(store, T0 + 10 * MIN);
    expect(stuck.status).toBe('stuck');
    expect(stuck.bubble).toBe('卡住？（執行指令：npm run build）');
    store.apply(ev('turn.end', T0 + 11 * MIN));
    expect(mainAt(store, T0 + 11 * MIN).status).toBe('done');
  });

  // office-transcript-observer spec, Scenario: 長時間工具呼叫
  it('goes stuck at 10 minutes and back to thinking when the tool returns', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Bash', toolUseId: 'b' }));
    expect(mainAt(store, T0 + 10 * MIN).status).toBe('stuck');
    store.apply(ev('tool.end', T0 + 12 * MIN, { toolUseId: 'b' }));
    expect(mainAt(store, T0 + 12 * MIN).status).toBe('thinking');
  });

  it('takes the thresholds from the config', () => {
    const store = new OfficeStore();
    store.apply(ev('turn.end', T0));
    const quick = { ...config, timing: { ...config.timing, idleAfterDoneMs: 1_000 } };
    expect(buildView(store, quick, T0 + 1_000).groups[0].actors[0].status).toBe('idle');
  });
});

describe('waiting for the user', () => {
  // office-transcript-observer spec, Scenario: 不裝 Hook 也看得到提問
  it('waits while an AskUserQuestion has no answer, without any hook', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'AskUserQuestion', toolUseId: 'q1' }));
    expect(mainAt(store, T0 + 1)).toMatchObject({ status: 'waiting', bubble: '等你回答' });
    store.apply(ev('tool.end', T0 + 5_000, { toolUseId: 'q1' }));
    expect(mainAt(store, T0 + 5_001).status).toBe('thinking');
  });

  it('waits for an ExitPlanMode answer too', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'ExitPlanMode', toolUseId: 'p1' }));
    expect(mainAt(store, T0 + 1).status).toBe('waiting');
  });

  // office-transcript-observer spec, Scenario: 權限確認透過 Hook
  it('waits after a hook notification until the next transcript event', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Bash', toolUseId: 'b' }));
    store.apply(ev('waiting', T0 + 1_000, { source: 'hook' }));
    expect(mainAt(store, T0 + 1_001)).toMatchObject({ status: 'waiting', bubble: '等你核准' });
    store.apply(ev('tool.end', T0 + 9_000, { toolUseId: 'b' }));
    expect(mainAt(store, T0 + 9_001).status).toBe('thinking');
  });
});

describe('sub-agents', () => {
  it('come in on handoff.out and leave on handoff.back', () => {
    const store = new OfficeStore();
    const sub = 's:sub:t1';
    store.apply(ev('handoff.out', T0, { actorId: sub, subagentType: 'Plan', detail: '規劃' }));
    expect(buildView(store, config, T0 + 1).groups[0].actors.map((a) => a.title)).toEqual(['主對話', '系統架構師']);
    store.apply(ev('handoff.back', T0 + 2, { actorId: sub }));
    expect(buildView(store, config, T0 + 3).groups[0].actors).toHaveLength(1);
  });
});
