import type { Department, DispatchSettings } from '../office/config.ts';
import type { DepartmentTheme } from '../office/types.ts';
import { DEFAULT_WORKER } from '../office/config.ts';
import { departmentTheme } from '../office/levels.ts';
import type { AgentRequest, Project, ProjectKind, QaMode, RouteStop } from './types.ts';

/**
 * A worker (組員) is one `claude -p` call per stop, in the project's folder,
 * running the department's speclink skill (or, for research, writing the
 * department's part of the report). This file builds what the call gets and
 * checks what it returns; foreman.ts decides when to call.
 *
 * Measured 2026-11-12 (design.md「實測」): a bare Write tool can write outside
 * the working folder, Edit(./**) / Write(./**) cannot; node / npx are left out
 * because any of them can write anywhere (the user chose 「只留測試與建置」).
 */

export const CODE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit(./**)',
  'Write(./**)',
  'Skill',
  'TodoWrite',
  'Bash(speclink:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run build:*)',
].join(',');

export const RESEARCH_TOOLS = ['Read', 'Glob', 'Grep', 'Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch'].join(',');

export const WORKER_OUTCOMES = ['done', 'question', 'rejected', 'failed'] as const;
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

const SUMMARY_MAX = 300;
const HANDOFF_MAX = 1000;
const OPTIONS_MAX = 4;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const INVALID_REPLY = '組員的回覆不合規則';

export const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: [...WORKER_OUTCOMES] },
    summary: { type: 'string', description: '這一站做了什麼（300 字內）' },
    handoff: { type: 'string', description: '交給下一站的重點（1000 字內）' },
    question: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: OPTIONS_MAX },
      },
      required: ['text'],
    },
    findings: { type: 'array', items: { type: 'string' }, description: '不合格的理由（rejected 才有）' },
    discussion: { type: 'string', description: 'speclink 討論 slug（需求分析站）' },
    change: { type: 'string', description: 'speclink change 名稱（規格企劃站起）' },
  },
  required: ['outcome', 'summary', 'handoff'],
} as const;

export interface WorkerOutput {
  outcome: WorkerOutcome;
  summary: string;
  handoff: string;
  question?: { text: string; options: string[] };
  findings?: string[];
  discussion?: string;
  change?: string;
  /** Things the worker reported that were ignored. */
  notes: string[];
}

export type WorkerCheck = { ok: true; value: WorkerOutput } | { ok: false; reason: string };

const cut = (s: string, max: number): string => [...s].slice(0, max).join('');
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Checks one worker's structured output; rejected is only a qa stop's answer. */
export function parseWorker(output: Record<string, unknown>, theme: DepartmentTheme | undefined): WorkerCheck {
  const bad = { ok: false, reason: INVALID_REPLY } as const;
  const outcome = output.outcome;
  if (typeof outcome !== 'string' || !(WORKER_OUTCOMES as readonly string[]).includes(outcome)) return bad;
  if (typeof output.summary !== 'string' || typeof output.handoff !== 'string') return bad;
  const value: WorkerOutput = {
    outcome: outcome as WorkerOutcome,
    summary: cut(output.summary.trim(), SUMMARY_MAX),
    handoff: cut(output.handoff.trim(), HANDOFF_MAX),
    notes: [],
  };
  if (outcome === 'question') {
    const q = output.question as Record<string, unknown> | undefined;
    if (!q || typeof q !== 'object' || !isText(q.text)) return bad;
    const options = Array.isArray(q.options) ? q.options.filter(isText).slice(0, OPTIONS_MAX).map((o) => cut(o.trim(), 100)) : [];
    value.question = { text: cut(q.text.trim(), 2000), options };
  }
  if (outcome === 'rejected') {
    if (theme !== 'qa') return bad;
    const findings = Array.isArray(output.findings) ? output.findings.filter(isText).map((f) => cut(f.trim(), 500)) : [];
    if (findings.length === 0) return bad;
    value.findings = findings;
  }
  for (const key of ['discussion', 'change'] as const) {
    const raw = output[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'string' && SLUG.test(raw)) value[key] = raw;
    else value.notes.push(`組員回報的 ${key === 'change' ? 'change 名稱' : '討論 slug'}格式不對，已略過`);
  }
  return { ok: true, value };
}

/** A route stop's department and its theme (the style that decides the station's job). */
export function stopDepartment(stop: RouteStop, departments: readonly Department[]): { department?: Department; theme?: DepartmentTheme } {
  const index = departments.findIndex((d) => d.id === stop.id);
  if (index < 0) return {};
  return { department: departments[index], theme: departmentTheme(departments[index], index) };
}

/** What the worker of one stop is told to do. */
export function stationTask(
  theme: DepartmentTheme | undefined,
  kind: ProjectKind,
  project: Pick<Project, 'discussion' | 'change' | 'qaMode'>,
  departmentName: string,
): string {
  const change = project.change ? `change ${project.change}` : '這個專案的 change（不知道名稱時先用 speclink list --json 找出來）';
  if (kind === 'research') {
    switch (theme) {
      case 'analysis':
        return '蒐集與這個需求有關的資料，列出重點與來源，寫進目前資料夾的 01-分析.md。';
      case 'spec':
        return '依前面的分析規劃報告大綱，寫進 02-大綱.md。';
      case 'build':
        return '依大綱寫報告本文，寫進 03-報告.md。';
      case 'qa':
        return '檢查報告內容是否正確、來源是否可查。有錯就回 outcome="rejected"，findings 逐條列出；沒有就回 outcome="done"。';
      case 'release':
        return '把報告整理成最終版 README.md，最後列出這個資料夾裡所有產出檔。';
      default:
        return `以「${departmentName}」的職責完成這一站，產出寫在目前資料夾。`;
    }
  }
  switch (theme) {
    case 'analysis':
      return '使用 speclink-discuss 技能討論這個需求並寫出討論紀錄。先列出你的假設，回傳 outcome="question" 請使用者確認哪些假設不對；收到回答後寫完結論，回傳 outcome="done"，discussion 填討論 slug。';
    case 'spec':
      return `使用 speclink-propose 技能建立 change${project.discussion ? `（加上 --from-discussion ${project.discussion}）` : ''}。完成後回傳 outcome="done"，change 填 change 名稱。`;
    case 'build':
      return `使用 speclink-apply 技能實作 ${change} 的所有非 [M] 任務。`;
    case 'qa':
      return `${QA_SKILLS[project.qaMode ?? 'both']}檢查 ${change}。有必修項（不修就不能交付的問題）時回傳 outcome="rejected"，findings 逐條列出；沒有就回傳 outcome="done"。`;
    case 'release':
      return `先確認 ${change} 的 tasks.md 沒有未勾的 [M] 手動任務（有的話回傳 outcome="question" 列出，請使用者完成後回覆）。然後使用 speclink-archive 技能封存，再用 git add 與 git commit 在本機提交這個資料夾的變更（資料夾不是 git 就略過提交）。絕不推送。`;
    default:
      return `以「${departmentName}」的職責完成這一站。`;
  }
}

/** What the qa worker runs for each choice; only the chosen skills are named. */
const QA_SKILLS: Record<QaMode, string> = {
  review: '使用 speclink-review 技能',
  verify: '使用 speclink-verify 技能',
  both: '依序使用 speclink-review 與 speclink-verify 技能',
};

/** The qa decision: the user picks the check (the work building has its own code review). */
export const QA_QUESTION = '6F 測試品管要跑哪一種檢查？';
export const QA_CHOICES: { mode: QaMode; label: string }[] = [
  { mode: 'review', label: 'review（看程式寫得好不好：正確性、可讀性、邊界情況）' },
  { mode: 'verify', label: 'verify（看有沒有照規格做完：需求、任務、情境逐條對）' },
  { mode: 'both', label: 'review + verify（兩個都跑，最完整也最花額度）' },
];

export const HEADLESS_RULES = [
  '規則：',
  '- 你在背景執行，沒有人能即時回答你，不能使用 AskUserQuestion。',
  '- 技能要你詢問使用者、等使用者回覆，或遇到 [M] 手動任務時，立刻停下，回傳 outcome="question"：question.text 寫問題，question.options 給 0～4 個建議答案。',
  '- 只能修改目前資料夾裡的檔案；絕不推送（git push）。',
  '- 這一站完成時回傳 outcome="done"；做不下去時回傳 outcome="failed"，在 summary 說明原因。',
  '- summary 寫這一站做了什麼（300 字內），handoff 寫交給下一站的重點（1000 字內）。',
].join('\n');

/** The first call of a stop. */
export function workerPrompt(
  project: Project,
  stop: RouteStop,
  departments: readonly Department[],
): string {
  const { department, theme } = stopDepartment(stop, departments);
  const name = department?.name ?? stop.id;
  const lines = [
    `你是 AI 辦公室 ${department ? `${department.floor}F ` : ''}${name}的組員。`,
    `專案：${project.title}`,
    `需求：${project.brief}`,
    `這一站的完成標準：${stop.doneWhen}`,
    '',
    `這一站的任務：${stationTask(theme, project.kind, project, name)}`,
  ];
  if (project.findings?.length && theme === 'build') {
    lines.push('', '6F 退回的問題，這次一定要修好：', ...project.findings.map((f) => `- ${f}`));
  }
  const notes = project.handoffNotes ?? [];
  if (notes.length > 0) {
    lines.push('', '前面各站的交接：');
    for (const note of notes) {
      const d = departments.find((x) => x.id === note.stop);
      lines.push(`【${d ? `${d.floor}F ${d.name}` : note.stop}】`, `做了什麼：${note.summary}`, `交接：${cut(note.handoff, HANDOFF_MAX)}`);
    }
  }
  lines.push('', HEADLESS_RULES);
  return lines.join('\n');
}

/** A later call of the same stop (the user's answer, or a note about the failure). */
export function resumePrompt(text: string): string {
  return `${text}\n\n${HEADLESS_RULES}`;
}

/** The whole request of one worker call. */
export function workerRequest(
  project: Project,
  stop: RouteStop,
  departments: readonly Department[],
  settings: DispatchSettings,
): AgentRequest {
  const { theme } = stopDepartment(stop, departments);
  const resumed = !!project.sessionStarted && !!project.resumeText;
  return {
    role: 'worker',
    model: settings.models.worker ?? DEFAULT_WORKER.model,
    schema: WORKER_SCHEMA,
    cwd: project.cwd,
    prompt: resumed ? resumePrompt(project.resumeText!) : workerPrompt(project, stop, departments),
    input: { role: 'worker', theme: theme ?? stop.id, kind: project.kind, title: project.title, resumed },
    tools: project.kind === 'code' ? CODE_TOOLS : RESEARCH_TOOLS,
    sessionId: project.sessionId!,
    resume: resumed,
    maxTurns: settings.workerMaxTurns ?? DEFAULT_WORKER.maxTurns,
    timeoutMs: (settings.workerTimeoutMin ?? DEFAULT_WORKER.timeoutMin) * 60_000,
  };
}
