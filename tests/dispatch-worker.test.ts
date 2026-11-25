import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { claudeArgs } from '../server/src/dispatch/runner.ts';
import type { Project, RouteStop } from '../server/src/dispatch/types.ts';
import {
  CODE_TOOLS,
  INVALID_REPLY,
  parseWorker,
  RESEARCH_TOOLS,
  stationTask,
  WORKER_SCHEMA,
  workerPrompt,
  workerRequest,
} from '../server/src/dispatch/worker.ts';

const departments = DEFAULT_CONFIG.departments;
const settings = { building: '私人樓', workRoot: 'D:\\work\\', models: { president: 'opus', manager: 'sonnet' } };

const stop = (id: string, doneWhen = '完成'): RouteStop => ({ id, doneWhen, required: id === 'qa' });
const project = (over: Partial<Project> = {}): Project => ({
  id: 'd20261112-001-1',
  title: '相簿作品集頁',
  kind: 'code',
  cwd: 'D:\\work\\album',
  brief: '相簿網站加一頁作品集',
  route: ['analysis', 'spec', 'build', 'qa', 'release'].map((id) => stop(id)),
  notes: [],
  risks: [],
  status: 'running',
  sessionId: '11111111-2222-3333-4444-555555555555',
  ...over,
});

describe('站要做的事 (spec Example)', () => {
  it.each([
    ['analysis', 'speclink-discuss', '01-分析.md'],
    ['spec', 'speclink-propose', '02-大綱.md'],
    ['build', 'speclink-apply', '03-報告.md'],
    ['qa', 'speclink-review', 'outcome="rejected"'],
    ['release', 'speclink-archive', 'README.md'],
  ] as const)('%s：程式專案用 %s，研究專案寫 %s', (theme, skill, research) => {
    expect(stationTask(theme, 'code', {}, 'x')).toContain(skill);
    expect(stationTask(theme, 'research', {}, 'x')).toContain(research);
    expect(stationTask(theme, 'research', {}, 'x')).not.toContain('speclink');
  });

  it('spec 有討論 slug 時加 --from-discussion；qa 同時用 review 與 verify；release 不推送', () => {
    expect(stationTask('spec', 'code', { discussion: 'album-portfolio' }, 'x')).toContain('--from-discussion album-portfolio');
    expect(stationTask('qa', 'code', { change: 'add-portfolio' }, 'x')).toMatch(/speclink-review.*speclink-verify.*add-portfolio/s);
    expect(stationTask('release', 'code', { change: 'add-portfolio' }, 'x')).toContain('絕不推送');
  });
});

describe('參數不含危險權限 (Scenario)', () => {
  it('build 站：dontAsk、程式專案工具清單、--session-id，沒有 bypass／push／node／npx／不存對話', () => {
    const args = claudeArgs(workerRequest(project({ stopIndex: 2 }), stop('build'), departments, settings));
    expect(args).toEqual([
      '-p', '--output-format', 'json', '--json-schema', JSON.stringify(WORKER_SCHEMA), '--model', 'sonnet',
      '--permission-mode', 'dontAsk', '--allowedTools', CODE_TOOLS, '--max-turns', '150',
      '--session-id', '11111111-2222-3333-4444-555555555555',
    ]);
    const joined = args.join(' ');
    for (const bad of ['bypassPermissions', 'git push', 'Bash(node', 'Bash(npx', 'Bash(npm:', '--no-session-persistence']) {
      expect(joined).not.toContain(bad);
    }
    expect(CODE_TOOLS).toContain('Edit(./**)');
    expect(CODE_TOOLS).toContain('Write(./**)');
    expect(CODE_TOOLS.split(',')).not.toContain('Write');
    expect(RESEARCH_TOOLS).toBe('Read,Glob,Grep,Edit(./**),Write(./**),WebSearch,WebFetch');
  });

  it('接續同一站時改用 --resume，提示是回答加規則；設定檔的模型、回合、逾時照用', () => {
    const p = project({ sessionStarted: true, resumeText: '使用者回答：12 件' });
    const request = workerRequest(p, stop('analysis'), departments, {
      ...settings,
      models: { ...settings.models, worker: 'opus' },
      workerMaxTurns: 40,
      workerTimeoutMin: 5,
    });
    const args = claudeArgs(request);
    expect(args.slice(-4)).toEqual(['--max-turns', '40', '--resume', '11111111-2222-3333-4444-555555555555']);
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(request.timeoutMs).toBe(5 * 60_000);
    expect(request.prompt.startsWith('使用者回答：12 件')).toBe(true);
    expect(request.prompt).toContain('不能使用 AskUserQuestion');
  });

  it('研究專案用研究工具清單', () => {
    const request = workerRequest(project({ kind: 'research' }), stop('analysis'), departments, settings);
    expect(request.tools).toBe(RESEARCH_TOOLS);
  });
});

describe('組員結果解析 (spec Example)', () => {
  const base = { outcome: 'done', summary: '做完了', handoff: '交接' };
  it.each([
    ['outcome done、summary、handoff', base, 'build', true],
    ['outcome question、question.text', { ...base, outcome: 'question', question: { text: '要放幾件作品？' } }, 'analysis', true],
    ['outcome question，沒有 question', { ...base, outcome: 'question' }, 'analysis', false],
    ['outcome rejected，findings 為空', { ...base, outcome: 'rejected', findings: [] }, 'qa', false],
    ['outcome finished', { ...base, outcome: 'finished' }, 'build', false],
  ] as const)('%s', (_name, output, theme, ok) => {
    const result = parseWorker(output as Record<string, unknown>, theme);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toEqual({ ok: false, reason: INVALID_REPLY });
  });

  it('change「Demo Portfolio!」：合格，change 忽略並記 note', () => {
    const result = parseWorker({ ...base, change: 'Demo Portfolio!' }, 'spec');
    expect(result.ok && result.value.change).toBe(undefined);
    expect(result.ok && result.value.notes).toEqual(['組員回報的 change 名稱格式不對，已略過']);
    const good = parseWorker({ ...base, change: 'demo-portfolio', discussion: 'album-ask' }, 'spec');
    expect(good.ok && [good.value.change, good.value.discussion]).toEqual(['demo-portfolio', 'album-ask']);
  });

  it('rejected 只有 qa 站能回；選項最多 4 個', () => {
    expect(parseWorker({ ...base, outcome: 'rejected', findings: ['缺測試'] }, 'build').ok).toBe(false);
    const q = parseWorker({ ...base, outcome: 'question', question: { text: '選哪個', options: ['a', 'b', 'c', 'd', 'e'] } }, 'analysis');
    expect(q.ok && q.value.question?.options).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('提示', () => {
  it('帶前站交接重點與 6F 退回的問題', () => {
    const prompt = workerPrompt(
      project({
        findings: ['匯出沒有 BOM'],
        handoffNotes: [{ stop: 'spec', summary: '建了 change', handoff: '注意 BOM' }],
      }),
      stop('build', 'tasks 全勾'),
      departments,
    );
    expect(prompt).toContain('5F 工程組的組員');
    expect(prompt).toContain('這一站的完成標準：tasks 全勾');
    expect(prompt).toContain('- 匯出沒有 BOM');
    expect(prompt).toContain('【4F 規格企劃組】');
    expect(prompt).toContain('交接：注意 BOM');
  });
});
