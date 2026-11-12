import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { managerPrompt, normalizeRoute } from '../server/src/dispatch/manager.ts';
import { checkPresident, presidentPrompt } from '../server/src/dispatch/president.ts';
import { ClaudeRunner, claudeArgs, parseResult } from '../server/src/dispatch/runner.ts';
import type { AgentRequest } from '../server/src/dispatch/types.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-dispatch-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const fakeRunner = (timeoutMs?: number) => new ClaudeRunner({ file: process.execPath, prefixArgs: [FAKE], timeoutMs });

const request = (prompt: string): AgentRequest => ({
  role: 'president',
  model: 'opus',
  schema: { type: 'object' },
  cwd: TMP,
  prompt,
  input: { role: 'president', text: 'x' },
});

describe('runner', () => {
  it('成功：取 structured_output 與用量，提示經 stdin 傳入、工作資料夾正確', async () => {
    const argsFile = path.join(TMP, 'args.json');
    const result = await fakeRunner().run(request(`MODE:ok ARGS:${argsFile} OUTPUT:{"projects":[]}`));
    expect(result).toEqual({
      ok: true,
      output: { projects: [] },
      usage: { turns: 2, durationMs: 1234, tokens: { input_tokens: 10, output_tokens: 20 }, costUsd: 0.01 },
    });
    const seen = JSON.parse(fs.readFileSync(argsFile, 'utf-8'));
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(TMP));
    expect(seen.argv).toEqual(claudeArgs({ model: 'opus', schema: { type: 'object' } }));
    // The prompt never travels on the command line.
    expect(seen.argv.join(' ')).not.toContain('MODE:ok');
  });

  it.each([
    ['結束碼非 0', 'MODE:exit1', '總裁執行失敗'],
    ['非 JSON', 'MODE:notjson', '總裁的回覆不是 JSON'],
    ['缺結構化輸出', 'MODE:noschema', '總裁沒有給出規定格式的結果'],
  ])('%s → 失敗「%s」', async (_label, prompt, reason) => {
    const result = await fakeRunner().run(request(prompt));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it('逾時 → 結束程序並回報「總裁逾時」', async () => {
    const started = Date.now();
    const result = await fakeRunner(500).run(request('MODE:sleep'));
    expect(!result.ok && result.reason).toBe('總裁逾時');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('執行檔不存在 → 「總裁無法啟動」', async () => {
    const result = await new ClaudeRunner({ file: path.join(TMP, 'no-claude.exe') }).run(request('MODE:ok'));
    expect(!result.ok && result.reason).toBe('總裁無法啟動');
  });

  it('is_error 為 true → 失敗；result 是 JSON 字串時也讀得到', () => {
    expect(parseResult(JSON.stringify({ is_error: true, subtype: 'error_max_turns' }), 'manager')).toMatchObject({ ok: false, reason: '經理執行失敗' });
    expect(parseResult(JSON.stringify({ subtype: 'success', result: '{"route":["qa"]}' }), 'manager')).toMatchObject({ ok: true, output: { route: ['qa'] } });
  });

  it('參數清單只給唯讀工具與 dontAsk，絕不含 bypassPermissions', () => {
    const args = claudeArgs({ model: 'sonnet', schema: {} });
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(args.join(' ')).not.toMatch(/bypass|skip-permissions/i);
  });
});

describe('總裁：資料夾檢查 (spec Example，workRoot 為 D:\\work\\)', () => {
  const WORK = 'D:\\work\\';
  const existing = new Set(['d:/work/resume', 'd:/workshop/app']);
  const isDir = (dir: string) => existing.has(dir.replace(/\\/g, '/').toLowerCase());
  const DIR = path.join('home', '.ai-office', 'projects', 'd20261110-001');
  const one = (kind: string, cwd: string | null) =>
    checkPresident({ projects: [{ title: '作品集頁面', kind, cwd, brief: '加一頁作品集' }] }, WORK, DIR, isDir);

  it.each([
    ['code', 'D:\\work\\resume', '（存在）', true],
    ['code', 'D:\\work\\resume2', '（不存在）', false],
    ['code', 'D:\\workshop\\app', '（存在）', false],
    ['code', null, '', false],
  ] as const)('%s %s%s → %s', (kind, cwd, _note, ok) => {
    const result = one(kind, cwd);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.reason).toBe('總裁給的資料夾不在可派工範圍');
  });

  it('research null → 通過，cwd 改為 ~/.ai-office/projects/<交辦編號>/output/1', () => {
    const result = one('research', null);
    expect(result).toEqual({ ok: true, projects: [{ title: '作品集頁面', kind: 'research', cwd: path.join(DIR, 'output', '1'), brief: '加一頁作品集' }] });
  });

  it('專案數 0 或 4 個 → 不合規則；名稱超過 40 字 → 不合規則', () => {
    expect(checkPresident({ projects: [] }, WORK, DIR, isDir).ok).toBe(false);
    const p = { title: 'a', kind: 'research', cwd: null, brief: 'b' };
    expect(checkPresident({ projects: [p, p, p, p] }, WORK, DIR, isDir).ok).toBe(false);
    expect(checkPresident({ projects: [{ ...p, title: '字'.repeat(41) }] }, WORK, DIR, isDir).ok).toBe(false);
  });

  it('總裁提示含交辦文字、部門清單與 workRoot', () => {
    const prompt = presidentPrompt('相簿網站加一頁作品集', DEFAULT_CONFIG.departments, WORK);
    expect(prompt).toContain('相簿網站加一頁作品集');
    expect(prompt).toContain('- build：5F 工程組');
    expect(prompt).toContain(WORK);
  });
});

describe('經理：路線整理 (spec Example，內建五部門)', () => {
  const D = DEFAULT_CONFIG.departments;
  it.each([
    ['code', ['analysis', 'spec', 'build', 'qa', 'release'], ['analysis', 'spec', 'build', 'qa', 'release'], []],
    ['code', ['build', 'spec'], ['spec', 'build', 'qa'], ['已補上 6F 測試品管組：改程式的專案一定要經過']],
    ['research', ['release', 'analysis', 'analysis'], ['analysis', 'release'], []],
    ['code', ['qa'], ['qa'], []],
  ] as const)('%s %j → %j', (kind, route, expected, notes) => {
    const result = normalizeRoute({ route: [...route], doneWhen: {}, risks: [] }, kind, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.map((s) => s.id)).toEqual(expected);
    expect(result.notes).toEqual(notes);
  });

  it('research marketing → （空）不合規則', () => {
    expect(normalizeRoute({ route: ['marketing'], doneWhen: {}, risks: [] }, 'research', D)).toEqual({
      ok: false,
      reason: '經理排的路線沒有任何可用部門',
    });
  });

  it('經理漏了測試品管站 (Scenario)：4F → 5F → 6F，qa 為必經', () => {
    const result = normalizeRoute({ route: ['build', 'spec'], doneWhen: { build: '首頁多一個連結' }, risks: ['圖片太大'] }, 'code', D);
    expect(result.ok && result.route).toEqual([
      { id: 'spec', doneWhen: '規格驗證通過', required: false },
      { id: 'build', doneWhen: '首頁多一個連結', required: false },
      { id: 'qa', doneWhen: '測試全過、審查沒有必修項', required: true },
    ]);
    expect(result.ok && result.risks).toEqual(['圖片太大']);
  });

  it('自訂部門：qa 主題由 theme 判斷，不看 id', () => {
    const custom = [
      { id: 'dev', name: '開發部', floor: 3, skills: ['a'], theme: 'build' as const },
      { id: 'check', name: '品保部', floor: 8, skills: ['b'], theme: 'qa' as const },
    ];
    const result = normalizeRoute({ route: ['dev'], doneWhen: {}, risks: [] }, 'code', custom);
    expect(result.ok && result.route.map((s) => [s.id, s.required])).toEqual([['dev', false], ['check', true]]);
    expect(result.ok && result.notes).toEqual(['已補上 8F 品保部：改程式的專案一定要經過']);
  });

  it('經理提示含專案資料、部門清單與預設完成標準', () => {
    const prompt = managerPrompt({ title: '作品集頁面', kind: 'code', brief: '加一頁作品集' }, D);
    expect(prompt).toContain('作品集頁面');
    expect(prompt).toContain('- qa：6F 測試品管組');
    expect(prompt).toContain('- build：tasks.md 程式任務全部勾選');
  });
});
