import type { Department, OfficeConfig } from './config.ts';
import { DEPARTMENT_THEMES } from './config.ts';
import type { DepartmentTheme, LevelView } from './types.ts';

/**
 * Floors inside a building. Every building has the same ones: 1F, the lobby
 * (the president's office and the free seats), 2F, the managers' floor, then
 * one floor per configured department. A session sits on the floor of the
 * department its current skill belongs to, or in the lobby.
 */

export const LOBBY_LEVEL = 1;
export const MANAGERS_LEVEL = 2;
export const LOBBY_NAME = '大廳';
export const MANAGERS_NAME = '經理室';

/** The floors of a building, lowest first, with no one counted yet. */
export function levelList(config: OfficeConfig): LevelView[] {
  return [
    { level: LOBBY_LEVEL, name: LOBBY_NAME, kind: 'lobby', theme: 'lobby', groups: 0 },
    { level: MANAGERS_LEVEL, name: MANAGERS_NAME, kind: 'managers', theme: 'managers', groups: 0 },
    ...config.departments
      .map((d, i): LevelView => ({
        level: d.floor,
        name: d.name,
        kind: 'department',
        departmentId: d.id,
        theme: departmentTheme(d, i),
        groups: 0,
      }))
      .sort((a, b) => a.level - b.level),
  ];
}

/**
 * How a department's floor looks: its own theme; else its id when that names
 * a style; else the styles in turn by its place in the config.
 */
export function departmentTheme(department: Department, index: number): DepartmentTheme {
  if (department.theme) return department.theme;
  const byId = DEPARTMENT_THEMES.find((t) => t === department.id);
  return byId ?? DEPARTMENT_THEMES[index % DEPARTMENT_THEMES.length];
}

/**
 * The floor of a session that used `skills` (oldest first): the department of
 * the newest skill that belongs to one; the lobby when none does. A skill no
 * department lists never moves anyone.
 */
export function levelForSkills(skills: readonly string[], config: OfficeConfig): number {
  for (let i = skills.length - 1; i >= 0; i--) {
    const department = config.departments.find((d) => d.skills.includes(skills[i]));
    if (department) return department.floor;
  }
  return LOBBY_LEVEL;
}
