import type { Department } from '../office/config.ts';
import { departmentTheme } from '../office/levels.ts';
import type { DepartmentTheme } from '../office/types.ts';
import { departmentLines } from './president.ts';
import type { ProjectKind, RouteStop } from './types.ts';

/**
 * The manager picks which departments a project goes through. Whatever the
 * model wrote, the route is put in order by fixed rules (normalizeRoute): known
 * departments only, each once, lowest floor first, and a code project always
 * goes through the qa department.
 */

export const DONE_WHEN_MAX = 200;
export const MAX_RISKS = 5;

/** What "done" means at each kind of department when the manager left it out. */
export const DEFAULT_DONE_WHEN: Record<DepartmentTheme, string> = {
  analysis: '假設清單經使用者確認',
  spec: '規格驗證通過',
  build: 'tasks.md 程式任務全部勾選',
  qa: '測試全過、審查沒有必修項',
  release: '封存完成',
};

export const MANAGER_SCHEMA = {
  type: 'object',
  properties: {
    route: { type: 'array', items: { type: 'string' }, minItems: 1 },
    doneWhen: { type: 'object', additionalProperties: { type: 'string', maxLength: DONE_WHEN_MAX } },
    risks: { type: 'array', items: { type: 'string', maxLength: DONE_WHEN_MAX }, maxItems: MAX_RISKS },
  },
  required: ['route', 'doneWhen', 'risks'],
} as const;

export function managerPrompt(
  project: { title: string; kind: ProjectKind; brief: string },
  departments: readonly Department[],
): string {
  const defaults = departments
    .map((d, i) => `- ${d.id}：${DEFAULT_DONE_WHEN[departmentTheme(d, i)]}`)
    .join('\n');
  return [
    '你是 AI 辦公室的經理。請替下面這個專案排出要經過哪些部門（route，填部門 id，由低樓層到高樓層），並寫下每一站的完成標準（doneWhen）與主要風險（risks，最多 5 項）。',
    '',
    '【專案】',
    `名稱：${project.title}`,
    `種類：${project.kind === 'code' ? '程式專案（會改程式）' : '研究／文件專案（不改程式）'}`,
    `說明：${project.brief}`,
    '',
    '【可用部門】',
    departmentLines(departments),
    '',
    '【各站預設完成標準】',
    defaults,
    '',
    '【規則】',
    '- 能跳過的站就跳過：規格已經很清楚的小修正可以不經過需求分析；純研究通常只需要需求分析與文件發佈。',
    '- 改程式的專案一定要經過測試品管。',
    `- 每站完成標準 ${DONE_WHEN_MAX} 字以內，要寫成檢查得到的條件。`,
    '- 你只能讀檔，不能修改任何檔案。',
  ].join('\n');
}

const chars = (s: string): number => [...s].length;

export type RouteCheck =
  | { ok: true; route: RouteStop[]; notes: string[]; risks: string[] }
  | { ok: false; reason: string };

/** The fixed route rules (spec「經理排路線」). */
export function normalizeRoute(
  output: Record<string, unknown>,
  kind: ProjectKind,
  departments: readonly Department[],
): RouteCheck {
  const raw = Array.isArray(output.route) ? output.route.filter((x): x is string => typeof x === 'string') : [];
  const byId = new Map(departments.map((d, i) => [d.id, { department: d, theme: departmentTheme(d, i) }]));
  const ids = [...new Set(raw.filter((id) => byId.has(id)))];
  const notes: string[] = [];
  const qa = departments.find((d, i) => departmentTheme(d, i) === 'qa');
  if (ids.length === 0) return { ok: false, reason: '經理排的路線沒有任何可用部門' };
  if (kind === 'code' && qa && !ids.includes(qa.id)) {
    ids.push(qa.id);
    notes.push(`已補上 ${qa.floor}F ${qa.name}：改程式的專案一定要經過`);
  }
  ids.sort((a, b) => byId.get(a)!.department.floor - byId.get(b)!.department.floor);

  const doneWhen = output.doneWhen && typeof output.doneWhen === 'object' ? (output.doneWhen as Record<string, unknown>) : {};
  const route: RouteStop[] = ids.map((id) => {
    const given = typeof doneWhen[id] === 'string' ? (doneWhen[id] as string).trim() : '';
    return {
      id,
      doneWhen: given && chars(given) <= DONE_WHEN_MAX ? given : DEFAULT_DONE_WHEN[byId.get(id)!.theme],
      required: kind === 'code' && qa !== undefined && id === qa.id,
    };
  });
  const risks = (Array.isArray(output.risks) ? output.risks : [])
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => r.trim())
    .filter((r) => chars(r) <= DONE_WHEN_MAX)
    .slice(0, MAX_RISKS);
  return { ok: true, route, notes, risks };
}
