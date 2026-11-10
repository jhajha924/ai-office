import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every "<call>:<path>" fs/promises was asked about, to prove what the watcher did and did not read. */
const touched: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = <F extends (...a: never[]) => unknown>(name: string, fn: F) =>
    ((...args: Parameters<F>) => {
      touched.push(`${name}:${String(args[0])}`);
      return fn(...args);
    }) as F;
  const recorded = {
    ...actual,
    stat: wrap('stat', actual.stat),
    readFile: wrap('readFile', actual.readFile),
    open: wrap('open', actual.open),
  };
  return { ...recorded, default: recorded };
});

const { DEFAULT_CONFIG } = await import('../server/src/office/config.ts');
const { OfficeStore } = await import('../server/src/office/store.ts');
const { mainActorId } = await import('../server/src/office/types.ts');
const { buildView } = await import('../server/src/office/view.ts');
const { changeHint } = await import('../server/src/observe/transcriptParser.ts');
const { countTasks } = await import('../server/src/observe/changeProgress.ts');
const { TranscriptWatcher } = await import('../server/src/observe/transcriptWatcher.ts');
const { toolUse, userText } = await import('./fixtures/lines.ts');

describe('which change a session works on', () => {
  // office-transcript-observer spec, Example: 變更名稱線索
  it.each([
    ['Skill', { skill: 'speclink-apply', args: 'ai-office-cards-feed' }, 'ai-office-cards-feed'],
    ['Skill', { skill: 'speclink-propose', args: '--from-discussion x' }, undefined],
    ['Skill', { skill: 'dataviz', args: 'chart' }, undefined],
    ['Bash', { command: 'speclink task done --change add-auth 3' }, 'add-auth'],
    ['Bash', { command: 'speclink validate --change=fix-login' }, 'fix-login'],
    ['Read', { file_path: 'D:\\home\\a\\openspec\\changes\\add-auth\\tasks.md' }, 'add-auth'],
    ['Read', { file_path: 'D:\\home\\a\\openspec\\changes\\archive\\2026-11-02-x\\tasks.md' }, undefined],
  ])('%s %j → %s', (tool, input, name) => {
    expect(changeHint(tool, input)?.name).toBe(name);
  });

  it('keeps the change folder a file path names', () => {
    expect(changeHint('Edit', { file_path: 'D:/home/a/openspec/changes/add-auth/design.md' })).toEqual({
      name: 'add-auth',
      dir: 'D:/home/a/openspec/changes/add-auth',
    });
  });
});

describe('counting tasks.md', () => {
  it('counts checked, unchecked and indented boxes, and nothing else', () => {
    const text = ['## 1. A', '- [x] 1.1 a', '- [X] 1.2 b', '  - [ ] 1.3 c', '- [ ] [M] 1.4 d', 'not - [x] a box', ''].join('\n');
    expect(countTasks(text)).toEqual({ done: 2, total: 4 });
  });

  it('has no ratio without boxes', () => {
    expect(countTasks('# nothing here')).toBeUndefined();
  });
});

describe('progress from tasks.md', () => {
  let root: string;
  let projects: string;
  let now: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-progress-'));
    projects = path.join(root, 'projects');
    fs.mkdirSync(projects);
    now = Date.now();
    touched.length = 0;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A project folder with a change whose tasks.md has `done` of `total` boxes checked. */
  function project(name: string, done: number, total: number): string {
    const dir = path.join(root, name);
    const change = path.join(dir, 'openspec', 'changes', 'ai-office-cards-feed');
    fs.mkdirSync(change, { recursive: true });
    const lines = Array.from({ length: total }, (_, i) => `- [${i < done ? 'x' : ' '}] ${i + 1} task`);
    fs.writeFileSync(path.join(change, 'tasks.md'), `## 1\n${lines.join('\n')}\n`);
    return dir;
  }

  function transcript(sessionId: string, cwd: string): string {
    const dir = path.join(projects, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${userText('開始', { cwd, at: now })}\n${toolUse('Skill', 'k1', { skill: 'speclink-apply', args: 'ai-office-cards-feed' }, { cwd, at: now })}\n`,
    );
    return file;
  }

  // office-transcript-observer spec, Scenario: apply 中的對話
  it('reports 5/17 for a private session applying a change', async () => {
    const home = project('home', 5, 17);
    transcript('s1', home);
    const store = new OfficeStore();
    const watcher = new TranscriptWatcher({ projectsDir: projects, store, config: { get: () => DEFAULT_CONFIG }, now: () => now });
    await watcher.scanOnce();
    const main = buildView(store, DEFAULT_CONFIG, now).groups[0].actors.find((a) => a.id === mainActorId('s1'))!;
    expect(main.progress).toEqual({ done: 5, total: 17 });
  });

  // office-transcript-observer spec, Scenario: 工作樓不讀
  it('never reads a tasks.md for a work-building session', async () => {
    const work = project('work', 5, 17);
    const config = {
      ...DEFAULT_CONFIG,
      buildings: { ...DEFAULT_CONFIG.buildings, rules: [{ prefix: work, building: '工作樓', mask: true }] },
    };
    const file = transcript('w1', work);
    fs.appendFileSync(file, `${toolUse('Bash', 'b1', { command: 'speclink task done --change ai-office-cards-feed 3' }, { cwd: work, at: now })}\n`);
    const store = new OfficeStore();
    const watcher = new TranscriptWatcher({ projectsDir: projects, store, config: { get: () => config }, now: () => now });
    await watcher.scanOnce();
    await watcher.scanOnce();
    expect(touched.filter((p) => p.includes('tasks.md'))).toEqual([]);
    expect(touched.filter((p) => p.includes(work))).toEqual([]);
    const main = buildView(store, config, now).groups[0].actors[0];
    expect(main.progress).toBe('indeterminate');
  });

  it('does not read an unchanged tasks.md again, and follows an edit', async () => {
    const home = project('home', 5, 17);
    const file = transcript('s2', home);
    const store = new OfficeStore();
    const watcher = new TranscriptWatcher({ projectsDir: projects, store, config: { get: () => DEFAULT_CONFIG }, now: () => now });
    await watcher.scanOnce();
    const tasks = path.join(home, 'openspec', 'changes', 'ai-office-cards-feed', 'tasks.md');
    const calls = (name: string) => touched.filter((p) => p === `${name}:${tasks}`).length;
    expect(calls('readFile')).toBe(1);

    // Next round, tasks.md untouched: looked at, not read again.
    fs.appendFileSync(file, `${userText('繼續', { cwd: home, at: now })}\n`);
    await watcher.scanOnce();
    expect(calls('stat')).toBe(2);
    expect(calls('readFile')).toBe(1);

    // tasks.md edited: read again, new ratio.
    fs.writeFileSync(tasks, `- [x] a\n- [x] b\n- [ ] c\n`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(tasks, later, later);
    await watcher.scanOnce();
    expect(calls('readFile')).toBe(2);
    expect(buildView(store, DEFAULT_CONFIG, now).groups[0].actors[0].progress).toEqual({ done: 2, total: 3 });
  });

  // office-transcript-observer spec, Scenario: 變更已封存
  it('clears the ratio when tasks.md moves away', async () => {
    const home = project('home', 5, 17);
    transcript('s3', home);
    const store = new OfficeStore();
    const watcher = new TranscriptWatcher({ projectsDir: projects, store, config: { get: () => DEFAULT_CONFIG }, now: () => now });
    await watcher.scanOnce();
    fs.rmSync(path.join(home, 'openspec', 'changes', 'ai-office-cards-feed'), { recursive: true });
    await watcher.scanOnce();
    expect(buildView(store, DEFAULT_CONFIG, now).groups[0].actors[0].progress).toBe('indeterminate');
  });
});
