import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Department } from '../office/config.ts';
import { isWithin, normalizeBuildingPath } from '../office/floorRouting.ts';
import type { ProjectKind } from './types.ts';

/**
 * The president splits one request into 1..3 projects. Its answer is held to
 * fixed rules here, whatever the model wrote: a code project must sit in an
 * existing folder under the work root; a research project always gets its
 * own output folder under the dispatch's directory.
 */

export const MAX_PROJECTS = 3;
export const TITLE_MAX = 40;
export const BRIEF_MAX = 500;

export const PRESIDENT_SCHEMA = {
  type: 'object',
  properties: {
    projects: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PROJECTS,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: TITLE_MAX },
          kind: { type: 'string', enum: ['code', 'research'] },
          cwd: { type: ['string', 'null'] },
          brief: { type: 'string', minLength: 1, maxLength: BRIEF_MAX },
        },
        required: ['title', 'kind', 'cwd', 'brief'],
      },
    },
  },
  required: ['projects'],
} as const;

export function departmentLines(departments: readonly Department[]): string {
  return [...departments]
    .sort((a, b) => a.floor - b.floor)
    .map((d) => `- ${d.id}：${d.floor}F ${d.name}`)
    .join('\n');
}

export function presidentPrompt(text: string, departments: readonly Department[], workRoot: string): string {
  return [
    '你是 AI 辦公室的總裁。使用者交辦了下面這件事，請把它拆成 1～3 個專案。',
    '',
    '【交辦內容】',
    text,
    '',
    '【可用部門】',
    departmentLines(departments),
    '',
    '【規則】',
    `- 程式專案（kind = code）：cwd 必須是「${workRoot}」底下已經存在的資料夾的完整路徑，可以用 Glob 確認。`,
    '- 研究、寫文件、整理資料的專案（kind = research）：cwd 填 null。',
    `- 最多 ${MAX_PROJECTS} 個專案；能一個專案做完就不要拆。`,
    `- title 是 ${TITLE_MAX} 字以內的專案名稱；brief 是 ${BRIEF_MAX} 字以內的說明，寫清楚要做什麼、做到什麼程度。`,
    '- 你只能讀檔，不能修改任何檔案。',
  ].join('\n');
}

export interface PlannedProject {
  title: string;
  kind: ProjectKind;
  cwd: string;
  brief: string;
}

const chars = (s: string): number => [...s].length;

/** Output folder of research project number `n` (1-based) of a dispatch. */
export function researchFolder(dispatchDir: string, n: number): string {
  return path.join(dispatchDir, 'output', String(n));
}

export type PresidentCheck = { ok: true; projects: PlannedProject[] } | { ok: false; reason: string };

/**
 * Validates the president's structured output. `isDir` is injectable for
 * the tests; the real one stats the folder.
 */
export function checkPresident(
  output: Record<string, unknown>,
  workRoot: string,
  dispatchDir: string,
  isDir: (dir: string) => boolean = defaultIsDir,
): PresidentCheck {
  const list = output.projects;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PROJECTS) {
    return { ok: false, reason: `總裁拆出的專案數不在 1～${MAX_PROJECTS} 個之間` };
  }
  const rootKey = normalizeBuildingPath(workRoot);
  const projects: PlannedProject[] = [];
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, reason: '總裁的專案格式不對' };
    const p = item as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const brief = typeof p.brief === 'string' ? p.brief.trim() : '';
    if (chars(title) < 1 || chars(title) > TITLE_MAX) return { ok: false, reason: '總裁給的專案名稱長度不對' };
    if (chars(brief) < 1 || chars(brief) > BRIEF_MAX) return { ok: false, reason: '總裁給的專案說明長度不對' };
    if (p.kind === 'research') {
      projects.push({ title, kind: 'research', cwd: researchFolder(dispatchDir, i + 1), brief });
      continue;
    }
    if (p.kind !== 'code') return { ok: false, reason: '總裁給的專案種類不對' };
    const cwd = typeof p.cwd === 'string' ? p.cwd.trim() : '';
    if (!cwd || !(path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) || !isWithin(normalizeBuildingPath(cwd), rootKey) || !isDir(cwd)) {
      return { ok: false, reason: '總裁給的資料夾不在可派工範圍' };
    }
    projects.push({ title, kind: 'code', cwd: path.normalize(cwd), brief });
  }
  return { ok: true, projects };
}

function defaultIsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
