import type { OfficeConfig } from '../office/config.ts';
import { DEFAULT_CONFIG } from '../office/config.ts';
import type { OfficeStore } from '../office/store.ts';
import type { OfficeEvent } from '../office/types.ts';
import { mainActorId, skillActorId, subActorId } from '../office/types.ts';

/**
 * Demo mode: a fixed one-minute script of OfficeEvents for six made-up
 * sessions on both floors, looping forever. It feeds the store exactly like
 * the transcript watcher does — through OfficeEvent — and touches no file at
 * all, so ~/.claude is never read.
 */

export const DEMO_LOOP_MS = 60_000;
const MIN = 60_000;

interface DemoSession {
  sessionId: string;
  cwd: string;
  label: string;
}

/** Every path and name below is made up. */
const WORK_DIR = 'C:\\Projects\\work\\';
const PERSONAL_DIR = 'C:\\Projects\\personal\\';

/**
 * The demo always shows both floors, whatever the user's config file says:
 * a masked 工作樓 for the work folder, 私人樓 for everything else.
 */
export const DEMO_CONFIG: OfficeConfig = {
  ...DEFAULT_CONFIG,
  floors: {
    rules: [{ prefix: WORK_DIR, floor: '工作樓', mask: true }],
    default: { floor: '私人樓', mask: false },
  },
};

const W1: DemoSession = { sessionId: 'demo-w1-0001', cwd: `${WORK_DIR}inventory-api`, label: '庫存 API 批次更新' };
const W2: DemoSession = { sessionId: 'demo-w2-0002', cwd: `${WORK_DIR}billing-service`, label: '帳單匯出欄位調整' };
const P1: DemoSession = { sessionId: 'demo-p1-0003', cwd: `${PERSONAL_DIR}weekly-report`, label: '本週銷售週報' };
const P2: DemoSession = { sessionId: 'demo-p2-0004', cwd: `${PERSONAL_DIR}photo-album`, label: '相簿網站改版' };
/** Finished a while ago: one idle (wanders the pantry and lounge), one long enough to doze. */
const P3: DemoSession = { sessionId: 'demo-p3-0005', cwd: `${PERSONAL_DIR}recipe-box`, label: '食譜整理' };
const W3: DemoSession = { sessionId: 'demo-w3-0006', cwd: `${WORK_DIR}billing-service`, label: '月結報表檢查' };
export const DEMO_SESSIONS = [W1, W2, P1, P2, P3, W3];
/** How often the finished sessions are reset, so P3 stays idle and W3 keeps dozing. */
const RESET_EVERY_MINUTES = 10;

const W1_FILE = `${W1.cwd}\\StockSync.cs`;
const P1_FILE = `${P1.cwd}\\週報草稿.md`;

/** What the preview window shows for the demo's private output files. */
const DEMO_PREVIEWS: Record<string, string> = {
  [P1_FILE]: '# 本週銷售週報（示範）\n\n- 訂單數：128\n- 營收：較上週 +6%\n- 待追蹤：3 則客戶回饋\n',
};

type Step = [seconds: number, session: DemoSession, kind: OfficeEvent['kind'], extra?: Partial<OfficeEvent>];

const OPUS = { model: 'claude-opus-5-5' };
const SONNET = { model: 'claude-sonnet-5-5' };

/** What happens in each minute, by second. */
const SCRIPT: Step[] = [
  // Work floor: a long-running session, details masked by the view.
  [0, W1, 'turn.start', OPUS],
  [2, W1, 'thinking', OPUS],
  [5, W1, 'tool.start', { ...OPUS, tool: 'Read', toolUseId: 'w1-r', detail: W1_FILE }],
  [9, W1, 'tool.end', { toolUseId: 'w1-r' }],
  [10, W1, 'actor.join', { actorId: skillActorId(W1.sessionId), skill: 'speclink-apply' }],
  [12, W1, 'tool.start', { ...OPUS, tool: 'Edit', toolUseId: 'w1-e', detail: W1_FILE }],
  [12, W1, 'output.add', { tool: 'Edit', toolUseId: 'w1-e', detail: W1_FILE }],
  [20, W1, 'tool.end', { toolUseId: 'w1-e' }],
  [22, W1, 'tool.start', { ...OPUS, tool: 'Bash', toolUseId: 'w1-b', detail: 'sqlcmd -S stock-db -Q "select 1"' }],
  [34, W1, 'tool.end', { toolUseId: 'w1-b' }],
  [36, W1, 'reply', OPUS],
  [40, W1, 'turn.end', OPUS],

  // Work floor: stops for a permission prompt, then goes on.
  [1, W2, 'turn.start', SONNET],
  [4, W2, 'tool.start', { ...SONNET, tool: 'Bash', toolUseId: 'w2-b', detail: 'git push' }],
  [6, W2, 'waiting', {}],
  [26, W2, 'tool.end', { toolUseId: 'w2-b' }],
  [28, W2, 'reply', SONNET],
  [31, W2, 'turn.end', SONNET],

  // Private floor: a researcher walks in and out, a reviewer is called, a question is asked.
  [0, P1, 'turn.start', OPUS],
  [0, P1, 'progress', { progress: { done: 3, total: 8 } }],
  [3, P1, 'tool.start', { ...OPUS, tool: 'Agent', toolUseId: 'p1-a' }],
  [3, P1, 'handoff.out', { ...SONNET, actorId: subActorId(P1.sessionId, 'p1-a'), subagentType: 'Explore', detail: '查本週銷售數字' }],
  [8, P1, 'tool.start', { ...OPUS, tool: 'Agent', toolUseId: 'p1-b' }],
  [8, P1, 'handoff.out', { ...SONNET, actorId: subActorId(P1.sessionId, 'p1-b'), subagentType: 'general-purpose', detail: '整理客戶回饋' }],
  [21, P1, 'handoff.back', { actorId: subActorId(P1.sessionId, 'p1-a'), toolUseId: 'p1-a' }],
  [21, P1, 'tool.end', { toolUseId: 'p1-a' }],
  [21, P1, 'progress', { progress: { done: 4, total: 8 } }],
  [27, P1, 'handoff.back', { actorId: subActorId(P1.sessionId, 'p1-b'), toolUseId: 'p1-b' }],
  [27, P1, 'tool.end', { toolUseId: 'p1-b' }],
  [29, P1, 'tool.start', { ...OPUS, tool: 'Skill', toolUseId: 'p1-s' }],
  [29, P1, 'actor.join', { actorId: skillActorId(P1.sessionId), skill: 'speclink-review' }],
  [30, P1, 'tool.end', { toolUseId: 'p1-s' }],
  [32, P1, 'tool.start', { ...OPUS, tool: 'Write', toolUseId: 'p1-w', detail: P1_FILE }],
  [32, P1, 'output.add', { tool: 'Write', toolUseId: 'p1-w', detail: P1_FILE }],
  [38, P1, 'tool.end', { toolUseId: 'p1-w' }],
  [38, P1, 'progress', { progress: { done: 5, total: 8 } }],
  [40, P1, 'tool.start', { ...OPUS, tool: 'AskUserQuestion', toolUseId: 'p1-q' }],
  [52, P1, 'tool.end', { toolUseId: 'p1-q' }],
  [54, P1, 'reply', OPUS],
  [57, P1, 'progress', { progress: { done: 6, total: 8 } }],
  [57, P1, 'turn.end', OPUS],
];

export class DemoSource {
  private timers: NodeJS.Timeout[] = [];
  private loop: NodeJS.Timeout | undefined;
  private minutes = 0;
  private readonly store: OfficeStore;
  private readonly now: () => number;

  constructor(store: OfficeStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  start(): void {
    this.runMinute();
    this.loop = setInterval(() => this.runMinute(), DEMO_LOOP_MS);
  }

  /** Built-in preview text of a demo output file; undefined for any other path. */
  previewText(path: string): string | undefined {
    return DEMO_PREVIEWS[path];
  }

  stop(): void {
    if (this.loop) clearInterval(this.loop);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private emit(session: DemoSession, kind: OfficeEvent['kind'], extra: Partial<OfficeEvent> = {}, at = this.now()): void {
    this.store.apply({
      kind,
      source: 'demo',
      sessionId: session.sessionId,
      actorId: mainActorId(session.sessionId),
      cwd: session.cwd,
      at,
      ...extra,
    });
    this.store.setLabel(session.sessionId, session.label);
  }

  private runMinute(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const now = this.now();
    // One session has been on the same build for 11 minutes: it shows 卡住？.
    this.emit(P2, 'tool.start', { ...OPUS, tool: 'Bash', toolUseId: 'p2-b', detail: 'npm run build' }, now - 11 * MIN);
    // P3 finished 5 minutes ago (idle), W3 20 minutes ago (dozing); reset now and then so they stay that way.
    if (this.minutes % RESET_EVERY_MINUTES === 0) {
      this.emit(P3, 'turn.end', SONNET, now - 5 * MIN);
      this.emit(W3, 'turn.end', SONNET, now - 20 * MIN);
    }
    this.minutes += 1;
    for (const session of DEMO_SESSIONS) this.store.touch(session.sessionId, session.cwd, now);
    this.store.prune(now, 30 * MIN);
    for (const [seconds, session, kind, extra] of SCRIPT) {
      this.timers.push(setTimeout(() => this.emit(session, kind, extra), seconds * 1_000));
    }
  }
}
