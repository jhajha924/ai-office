import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const touched: string[] = [];

function recording<T extends object>(actual: T): T {
  return new Proxy(actual, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        touched.push(`${String(key)}:${String(args[0])}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...recording(actual), default: recording(actual) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...recording(actual), default: recording(actual) };
});

const { DEFAULT_CONFIG } = await import('../server/src/office/config.ts');
const { OfficeStore } = await import('../server/src/office/store.ts');
const { buildView } = await import('../server/src/office/view.ts');
const { DEMO_CONFIG, DEMO_LOOP_MS, DEMO_SESSIONS, DemoSource } = await import('../server/src/demo/demoSource.ts');
const { createApp } = await import('../server/src/app.ts');

afterEach(() => {
  vi.useRealTimers();
});

/** The user's personal blocklist, when there is one: none of it may show up in the demo. */
function blocklist(): string[] {
  const file = path.join(os.homedir(), '.ai-office', 'public-blocklist.txt');
  try {
    return fs
      .readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

describe('demo mode', () => {
  // office-event-stream spec, Scenario: 示範模式
  it('covers both buildings, six groups and every special state within a minute, without reading files', async () => {
    vi.useFakeTimers();
    let clock = new Date(2026, 9, 31, 10, 0, 0).getTime();
    const store = new OfficeStore();
    const demo = new DemoSource(store, () => clock);
    // The recorder itself works: a direct fs call shows up.
    (await import('node:fs')).existsSync('probe');
    expect(touched).toContain('existsSync:probe');
    touched.length = 0;
    demo.start();

    const seen = {
      subIn: false,
      subOut: false,
      skill: false,
      waiting: false,
      stuck: false,
      idle: false,
      dozing: false,
      progress: false,
      handoffFeed: false,
      doneFeed: false,
    };
    let hadSub = false;
    for (let s = 0; s <= DEMO_LOOP_MS / 1_000; s++) {
      const view = buildView(store, DEMO_CONFIG, clock);
      const actors = view.groups.flatMap((g) => g.actors);
      const subNow = actors.some((a) => a.role === 'subagent');
      if (subNow) seen.subIn = true;
      if (hadSub && !subNow) seen.subOut = true;
      hadSub = subNow;
      if (actors.some((a) => a.role === 'skill')) seen.skill = true;
      for (const status of ['waiting', 'stuck', 'idle', 'dozing'] as const) {
        if (actors.some((a) => a.status === status)) seen[status] = true;
      }
      if (actors.some((a) => typeof a.progress === 'object')) seen.progress = true;
      if (view.feed.some((f) => f.kind === 'handoff')) seen.handoffFeed = true;
      if (view.feed.some((f) => f.kind === 'done')) seen.doneFeed = true;
      expect(new Set(view.groups.map((g) => g.building))).toEqual(new Set(['工作樓', '私人樓']));
      expect(view.groups).toHaveLength(6);
      clock += 1_000;
      vi.advanceTimersByTime(1_000);
    }
    demo.stop();

    expect(seen).toEqual({
      subIn: true,
      subOut: true,
      skill: true,
      waiting: true,
      stuck: true,
      idle: true,
      dozing: true,
      progress: true,
      handoffFeed: true,
      doneFeed: true,
    });
    expect(touched.filter((t) => t.includes('.claude'))).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('keeps the work-building details masked in the demo too', () => {
    vi.useFakeTimers();
    let clock = new Date(2026, 9, 31, 10, 0, 0).getTime();
    const store = new OfficeStore();
    const demo = new DemoSource(store, () => clock);
    demo.start();
    for (let s = 0; s < 60; s++) {
      const text = JSON.stringify(buildView(store, DEMO_CONFIG, clock));
      expect(text).not.toContain('StockSync.cs');
      expect(text).not.toContain('sqlcmd');
      clock += 1_000;
      vi.advanceTimersByTime(1_000);
    }
    demo.stop();
  });

  // office-event-stream spec, Example: 示範小組的樓層
  it('spreads the groups over 1F, 5F, 6F and 7F and moves one from 5F to 6F every minute', () => {
    vi.useFakeTimers();
    let clock = new Date(2026, 9, 31, 10, 0, 0).getTime();
    const store = new OfficeStore();
    const demo = new DemoSource(store, () => clock);
    demo.start();
    const seen = new Map<string, Set<number>>();
    const steps: number[] = [];
    let firstOnSix: number | undefined;
    for (let s = 0; s < DEMO_LOOP_MS / 1_000; s++) {
      const view = buildView(store, DEMO_CONFIG, clock);
      for (const g of view.groups) {
        const key = `${g.building} ${g.label}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(g.level);
        if (g.label === '本週銷售週報') {
          steps.push(g.level);
          if (g.level === 6 && firstOnSix === undefined) firstOnSix = s;
        }
      }
      clock += 1_000;
      vi.advanceTimersByTime(1_000);
    }
    demo.stop();
    const levels = (key: string) => [...(seen.get(key) ?? [])].sort();
    expect(levels('工作樓 庫存 API 批次更新')).toEqual([5]);
    expect(levels('工作樓 帳單匯出欄位調整')).toEqual([1]);
    expect(levels('工作樓 月結報表檢查')).toEqual([7]);
    expect(levels('私人樓 本週銷售週報')).toEqual([5, 6]);
    expect(levels('私人樓 相簿網站改版')).toEqual([5]);
    expect(levels('私人樓 食譜整理')).toEqual([1]);
    // 5F first, then 6F from second 29 on: exactly one move.
    const moves = steps.filter((l, i) => i > 0 && l !== steps[i - 1]);
    expect(moves).toEqual([6]);
    expect(firstOnSix).toBe(29);
  });

  // office-event-stream spec, Scenario: 沒有設定檔也能看到兩樓層示範
  it('shows both buildings even when the user config is the single-building default', async () => {
    const app = createApp({ port: 0, config: { get: () => DEFAULT_CONFIG }, demo: true, projectsDir: 'unused' });
    const port = await app.start();
    try {
      const view = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { buildings: { name: string }[] };
      expect(view.buildings.map((f) => f.name)).toEqual(['工作樓', '私人樓']);
      expect(app.sources).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  // office-event-stream spec, Example: 示範資料路徑
  it('uses made-up folders only: work under C:\\Projects\\work, personal under C:\\Projects\\personal', () => {
    for (const s of DEMO_SESSIONS) expect(s.cwd).toMatch(/^C:\\Projects\\(work|personal)\\/);
    expect(DEMO_SESSIONS.map((s) => s.cwd)).toContain('C:\\Projects\\work\\inventory-api');
    expect(DEMO_SESSIONS.map((s) => s.cwd)).toContain('C:\\Projects\\personal\\weekly-report');
  });

  it('contains nothing from the personal blocklist', async () => {
    const script = (await import('node:fs')).readFileSync(path.join(import.meta.dirname, '..', 'server', 'src', 'demo', 'demoSource.ts'), 'utf-8');
    for (const word of blocklist()) expect(script.toLowerCase(), word).not.toContain(word.toLowerCase());
  });
});

describe('demo previews', () => {
  it('serves the built-in text for its own output and nothing for other paths', () => {
    const demo = new DemoSource(new OfficeStore());
    expect(demo.previewText('C:\\Projects\\personal\\weekly-report\\週報草稿.md')).toContain('本週銷售週報');
    expect(demo.previewText('C:\\Windows\\win.ini')).toBeUndefined();
  });
});
