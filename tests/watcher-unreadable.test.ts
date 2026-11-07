import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Folders whose listing fails while this is set (simulates a locked folder for one round). */
const blocked = new Set<string>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = ((p: fs.PathLike, o?: unknown) =>
    blocked.has(String(p))
      ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      : actual.readdir(p, o as never)) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const { DEFAULT_CONFIG } = await import('../server/src/office/config.ts');
const { OfficeStore } = await import('../server/src/office/store.ts');
const { TranscriptWatcher } = await import('../server/src/observe/transcriptWatcher.ts');
const { userText } = await import('./fixtures/lines.ts');

describe('a project folder that cannot be listed for a round', () => {
  let root = '';
  afterEach(() => {
    blocked.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps its groups instead of re-reading them from scratch', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-watch2-'));
    const dir = path.join(root, 'd--side-project-x');
    fs.mkdirSync(dir);
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'a.jsonl'), `${userText('開始', { at: now })}\n`);
    const store = new OfficeStore();
    let applied = 0;
    const apply = store.apply.bind(store);
    store.apply = (e) => {
      applied += 1;
      apply(e);
    };
    const watcher = new TranscriptWatcher({ projectsDir: root, store, config: { get: () => DEFAULT_CONFIG }, now: () => now });
    await watcher.scanOnce();
    expect(store.groups.size).toBe(1);
    const before = applied;

    blocked.add(dir);
    await watcher.scanOnce();
    expect(store.groups.size).toBe(1);

    blocked.clear();
    await watcher.scanOnce();
    expect(store.groups.size).toBe(1);
    expect(applied).toBe(before);
  });

  it('keeps every group when the projects folder itself cannot be listed', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-watch3-'));
    const dir = path.join(root, 'd--side-project-y');
    fs.mkdirSync(dir);
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'b.jsonl'), `${userText('開始', { at: now })}\n`);
    const store = new OfficeStore();
    const watcher = new TranscriptWatcher({ projectsDir: root, store, config: { get: () => DEFAULT_CONFIG }, now: () => now });
    await watcher.scanOnce();
    blocked.add(root);
    await watcher.scanOnce();
    expect(store.groups.size).toBe(1);
  });
});
