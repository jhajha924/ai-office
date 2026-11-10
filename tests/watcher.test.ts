import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TWO_BUILDINGS } from './fixtures/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import type { OfficeEvent } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';
import { STARTUP_TAIL_BYTES, TranscriptWatcher } from '../server/src/observe/transcriptWatcher.ts';
import { aiTitle, resetClock, text, thinking, toolResult, toolUse, userText, WORK_CWD } from './fixtures/lines.ts';

class RecordingStore extends OfficeStore {
  events: OfficeEvent[] = [];
  override apply(event: OfficeEvent): void {
    this.events.push(event);
    super.apply(event);
  }
}

const MIN = 60_000;

describe('transcript watcher', () => {
  let root: string;
  let projectDir: string;
  let store: RecordingStore;
  let now: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-watch-'));
    projectDir = path.join(root, 'D--side-project-x');
    fs.mkdirSync(projectDir);
    store = new RecordingStore();
    now = Date.now();
    resetClock(now - 10 * MIN);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const watcher = () =>
    new TranscriptWatcher({ projectsDir: root, store, config: { get: () => TWO_BUILDINGS }, now: () => now });
  const file = (name = 'sess-1') => path.join(projectDir, `${name}.jsonl`);
  const append = (f: string, data: string) => fs.appendFileSync(f, data, 'utf-8');

  // office-transcript-observer spec, Scenario: 一行寫到一半
  it('waits for a half-written line and parses it exactly once', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const w = watcher();
    await w.scanOnce();
    const line = toolUse('Read', 't1', { file_path: 'D:\\home\\x\\a.md' });
    const cut = Buffer.from(line, 'utf-8');
    // Cut inside the multi-byte cwd so a character is split across reads.
    const at = cut.indexOf(Buffer.from('一般', 'utf-8')) + 1;
    fs.appendFileSync(f, cut.subarray(0, at));
    await w.scanOnce();
    expect(store.events).toHaveLength(0);
    fs.appendFileSync(f, Buffer.concat([cut.subarray(at), Buffer.from('\n')]));
    await w.scanOnce();
    expect(store.events.map((e) => e.kind)).toEqual(['tool.start']);
    expect(store.events[0].cwd).toContain('notes');
  });

  // office-transcript-observer spec, Scenario: 不重讀舊內容
  it('only parses lines added since the last scan', async () => {
    const f = file();
    fs.writeFileSync(f, `${userText('開始')}\n`);
    const w = watcher();
    await w.scanOnce();
    store.events = [];
    append(f, `${thinking()}\n${toolUse('Bash', 'b1', { command: 'ls' })}\n${toolResult('b1')}\n`);
    await w.scanOnce();
    expect(store.events.map((e) => e.kind)).toEqual(['thinking', 'tool.start', 'tool.end']);
  });

  it('never writes to the transcript', async () => {
    const f = file();
    fs.writeFileSync(f, `${userText('開始')}\n${thinking()}\n`);
    const before = { text: fs.readFileSync(f, 'utf-8'), mtime: fs.statSync(f).mtimeMs };
    const w = watcher();
    await w.scanOnce();
    await w.scanOnce();
    expect(fs.readFileSync(f, 'utf-8')).toBe(before.text);
    expect(fs.statSync(f).mtimeMs).toBe(before.mtime);
    expect(fs.readdirSync(projectDir)).toEqual(['sess-1.jsonl']);
  });

  it('ignores sub-agent transcripts in sub-folders', async () => {
    const sub = path.join(projectDir, 'sess-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), `${userText('子代理')}\n`);
    await watcher().scanOnce();
    expect(store.groups.size).toBe(0);
  });

  // office-transcript-observer spec, Scenario: 一小時前結束的對話
  it('leaves out a transcript last updated an hour before start-up', async () => {
    const f = file('old');
    fs.writeFileSync(f, `${userText('舊的', { at: now - 61 * MIN })}\n`);
    const old = new Date(now - 60 * MIN);
    fs.utimesSync(f, old, old);
    const w = watcher();
    await w.scanOnce();
    expect(store.groups.size).toBe(0);
    // A new line later brings it in, history still not replayed.
    append(f, `${userText('又回來了', { at: now })}\n`);
    await w.scanOnce();
    expect(store.events.map((e) => e.kind)).toEqual(['turn.start']);
    expect(store.groups.get('old')?.label).toBe('舊的');
  });

  // office-transcript-observer spec, Scenario: 進行中的大型紀錄檔
  it('rebuilds a big recent transcript from its tail only', async () => {
    const f = file('big');
    const filler = `${toolResult('x')}\n`.repeat(Math.ceil((STARTUP_TAIL_BYTES * 3) / 200));
    fs.writeFileSync(f, `${userText('大型對話的第一句')}\n${filler}`);
    append(f, `${toolUse('Grep', 'g1', { pattern: 'x' })}\n`);
    await watcher().scanOnce();
    const total = fs.statSync(f).size;
    expect(total).toBeGreaterThan(STARTUP_TAIL_BYTES * 2);
    // Far fewer events than lines in the file: only the tail was read.
    expect(store.events.length).toBeLessThan(STARTUP_TAIL_BYTES / 100);
    const group = buildView(store, TWO_BUILDINGS, now).groups[0];
    expect(group.label).toBe('大型對話的第一句');
    expect(group.actors[0]).toMatchObject({ status: 'running', tool: 'Grep' });
  });

  it('removes the group when its transcript is deleted', async () => {
    const f = file();
    fs.writeFileSync(f, `${userText('開始', { at: now })}\n`);
    const w = watcher();
    await w.scanOnce();
    expect(store.groups.size).toBe(1);
    fs.rmSync(f);
    await w.scanOnce();
    expect(store.groups.size).toBe(0);
  });

  // office-session-groups spec, Scenario: 關閉對話 / 隔天繼續同一個對話
  it('takes a silent group out after 30 minutes and brings it back with its label', async () => {
    const f = file();
    fs.writeFileSync(f, `${userText('原本的名稱', { at: now })}\n${text('end_turn', { at: now })}\n`);
    const w = watcher();
    await w.scanOnce();
    expect(store.groups.get('sess-1')?.label).toBe('原本的名稱');
    now += 30 * MIN;
    await w.scanOnce();
    expect(store.groups.size).toBe(0);
    append(f, `${userText('繼續', { at: now })}\n`);
    now += 10_000;
    await w.scanOnce();
    expect(store.groups.get('sess-1')?.label).toBe('原本的名稱');
  });

  // office-building-routing spec, Scenario: 工作對話切換到暫存資料夾
  it('keeps a work session on the masked building after its cwd moves elsewhere', async () => {
    const work = path.join(root, 'd--work-app');
    fs.mkdirSync(work);
    const f = path.join(work, 'w-1.jsonl');
    const temp = 'C:/Users/User/AppData/Local/Temp/claude/d--work-app/w-1/scratchpad';
    fs.writeFileSync(f, `${userText('Billing 批價', { cwd: WORK_CWD, at: now })}\n`);
    const w = watcher();
    await w.scanOnce();
    append(f, `${toolUse('Read', 'r1', { file_path: 'D:/work/app/Billing.pas' }, { cwd: temp, at: now + 1 })}\n`);
    await w.scanOnce();
    const view = buildView(store, TWO_BUILDINGS, now + 2);
    expect(view.groups[0].building).toBe('工作樓');
    expect(view.groups[0].actors[0].bubble).toBe('讀取檔案');
    expect(JSON.stringify(view)).not.toContain('Billing.pas');
  });

  it('uses the project folder name while the start cwd is unknown', async () => {
    const work = path.join(root, 'd--work-tools');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'w-2.jsonl'), '');
    await watcher().scanOnce();
    store.touch('w-2', 'C:/Temp/elsewhere', now);
    expect(buildView(store, TWO_BUILDINGS, now).groups[0].building).toBe('工作樓');
  });

  describe('group label from the conversation title', () => {
    const slash = '<command-name>/speclink-discuss</command-name>\n<command-args>x</command-args>';
    const label = () => [...store.groups.values()][0]?.label;

    // office-session-groups spec, Scenario: 有對話標題
    it('uses the title instead of the slash command', async () => {
      fs.writeFileSync(file(), `${userText(slash, { at: now })}\n${aiTitle('Work Eng Game 專案建置')}\n`);
      await watcher().scanOnce();
      expect(label()).toBe('Work Eng Game 專…');
    });

    // office-session-groups spec, Scenario: 標題更新
    it('follows a newer title', async () => {
      const f = file();
      fs.writeFileSync(f, `${userText('開始', { at: now })}\n${aiTitle('需求討論')}\n`);
      const w = watcher();
      await w.scanOnce();
      expect(label()).toBe('需求討論');
      append(f, `${aiTitle('週報整理')}\n`);
      await w.scanOnce();
      expect(label()).toBe('週報整理');
    });

    // office-session-groups spec, Scenario: 還沒有標題時用第一則訊息
    it('falls back to the first user message without a title', async () => {
      fs.writeFileSync(file(), `${userText('Order 同群組批價更新時要一併更新同採購單號的其他明細', { at: now })}\n`);
      await watcher().scanOnce();
      expect(label()).toBe('Order 同群組批價更新時要…');
    });

    it('finds the title in the tail of a big transcript at start-up', async () => {
      const f = file('big');
      const filler = `${toolResult('x')}\n`.repeat(Math.ceil((STARTUP_TAIL_BYTES * 3) / 200));
      fs.writeFileSync(f, `${userText(slash)}\n${filler}${aiTitle('大型對話的標題')}\n${userText('繼續', { at: now })}\n`);
      await watcher().scanOnce();
      expect(label()).toBe('大型對話的標題');
    });
  });

  it('shows "對話 xxxx" until a first user message appears', async () => {
    const f = file('abcd9999');
    fs.writeFileSync(f, `${thinking({ at: now })}\n`);
    await watcher().scanOnce();
    expect(buildView(store, TWO_BUILDINGS, now).groups[0].label).toBe('對話 abcd');
  });
});
