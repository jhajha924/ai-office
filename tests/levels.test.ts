import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OfficeConfig } from '../server/src/office/config.ts';
import { createConfigSource, DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { levelForSkills, levelList } from '../server/src/office/levels.ts';
import { OfficeStore, SKILLS_KEPT } from '../server/src/office/store.ts';
import type { OfficeEvent } from '../server/src/office/types.ts';
import { mainActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';
import { TWO_BUILDINGS } from './fixtures/config.ts';

describe('departments', () => {
  let dir: string;
  let file: string;
  let warnings: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-levels-'));
    file = path.join(dir, 'config.json');
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function load(departments: unknown): OfficeConfig {
    fs.writeFileSync(file, JSON.stringify({ departments }));
    return createConfigSource(file, { warn: (m) => warnings.push(m) }).get();
  }

  // office-building-floors spec, Example: 內建部門 / Scenario: 沒有設定 departments
  it('has the five built-in departments and the fixed lobby and managers floors', () => {
    expect(DEFAULT_CONFIG.departments).toEqual([
      { id: 'analysis', name: '需求分析組', floor: 3, skills: ['speclink-discuss', 'spectra-discuss'] },
      { id: 'spec', name: '規格企劃組', floor: 4, skills: ['speclink-propose', 'speclink-ingest', 'spectra-propose', 'spectra-ingest'] },
      { id: 'build', name: '工程組', floor: 5, skills: ['speclink-apply', 'spectra-apply'] },
      {
        id: 'qa',
        name: '測試品管組',
        floor: 6,
        skills: ['speclink-review', 'speclink-verify', 'speclink-audit', 'speclink-quality', 'spectra-verify', 'spectra-audit'],
      },
      { id: 'release', name: '文件發佈組', floor: 7, skills: ['speclink-archive', 'speclink-commit', 'spectra-archive', 'spectra-commit'] },
    ]);
    expect(levelList(DEFAULT_CONFIG).map((l) => `${l.level}F ${l.name}`)).toEqual([
      '1F 大廳',
      '2F 經理室',
      '3F 需求分析組',
      '4F 規格企劃組',
      '5F 工程組',
      '6F 測試品管組',
      '7F 文件發佈組',
    ]);
    expect(levelList(DEFAULT_CONFIG).map((l) => l.kind)).toEqual(['lobby', 'managers', 'department', 'department', 'department', 'department', 'department']);
  });

  // office-building-floors spec, Example: departments 驗證
  it('accepts an empty list: only 1F and 2F', () => {
    const config = load([]);
    expect(warnings).toEqual([]);
    expect(levelList(config).map((l) => l.level)).toEqual([1, 2]);
  });

  it.each([
    ['a floor of 2', [{ id: 'a', name: 'A', floor: 2, skills: ['x'] }]],
    [
      'two departments on floor 5',
      [
        { id: 'a', name: 'A', floor: 5, skills: ['x'] },
        { id: 'b', name: 'B', floor: 5, skills: ['y'] },
      ],
    ],
    ['empty skills', [{ id: 'a', name: 'A', floor: 5, skills: [] }]],
    ['theme "gym"', [{ id: 'a', name: 'A', floor: 5, skills: ['x'], theme: 'gym' }]],
  ])('falls back to the built-in defaults with one warning for %s', (_, departments) => {
    expect(load(departments)).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it('accepts a department on floor 8 with its own skill', () => {
    const config = load([{ id: 'mine', name: '我的組', floor: 8, skills: ['my-skill'] }]);
    expect(warnings).toEqual([]);
    expect(levelList(config).map((l) => l.level)).toEqual([1, 2, 8]);
    expect(levelForSkills(['my-skill'], config)).toBe(8);
  });

  // office-building-floors spec, Scenario: 技能重複
  it('falls back to the defaults with one warning when two departments share a skill', () => {
    const config = load([
      { id: 'a', name: 'A', floor: 5, skills: ['speclink-apply'] },
      { id: 'b', name: 'B', floor: 6, skills: ['speclink-apply'] },
    ]);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('departments[1].skills[0]');
  });

  // office-building-floors spec, Example: 主題決定
  it('gives 1F and 2F their fixed themes and the built-in departments their own', () => {
    const themes = levelList(DEFAULT_CONFIG).map((l) => [l.level, l.theme]);
    expect(themes[0]).toEqual([1, 'lobby']);
    expect(themes[1]).toEqual([2, 'managers']);
    expect(themes.find(([level]) => level === 5)).toEqual([5, 'build']);
  });

  it.each([
    [
      'the third department, id ops, no theme',
      [
        { id: 'a', name: 'A', floor: 8, skills: ['x'] },
        { id: 'b', name: 'B', floor: 9, skills: ['y'] },
        { id: 'ops', name: 'O', floor: 10, skills: ['z'] },
      ],
      10,
      'build',
    ],
    ['id ops, theme qa', [{ id: 'ops', name: 'O', floor: 8, skills: ['z'], theme: 'qa' }], 8, 'qa'],
    ['id build, theme release', [{ id: 'build', name: 'B', floor: 8, skills: ['z'], theme: 'release' }], 8, 'release'],
  ])('%s → %s', (_, departments, level, theme) => {
    const config = load(departments);
    expect(warnings).toEqual([]);
    expect(levelList(config).find((l) => l.level === level)?.theme).toBe(theme);
  });

  // office-building-floors spec, Scenario: 自訂部門沒填主題
  it('gives a lone custom department without a theme the first style', () => {
    const config = load([{ id: 'ops', name: 'O', floor: 8, skills: ['deploy'] }]);
    expect(levelList(config).find((l) => l.level === 8)?.theme).toBe('analysis');
  });
});

describe('skills a group used', () => {
  const use = (store: OfficeStore, skill: string, at: number) =>
    store.apply({ kind: 'skill.use', source: 'observe', sessionId: 's', actorId: mainActorId('s'), cwd: 'D:\\home\\x', at, skill });

  it('keeps each skill once, newest last, at most SKILLS_KEPT', () => {
    const store = new OfficeStore();
    use(store, 'speclink-apply', 1);
    use(store, 'speclink-review', 2);
    use(store, 'speclink-apply', 3);
    expect(store.groups.get('s')!.skills).toEqual(['speclink-review', 'speclink-apply']);

    for (let i = 0; i < SKILLS_KEPT; i++) use(store, `skill-${i}`, 10 + i);
    const skills = store.groups.get('s')!.skills;
    expect(skills).toHaveLength(SKILLS_KEPT);
    expect(skills[0]).toBe('skill-0');
    expect(skills).not.toContain('speclink-review');
    expect(skills.at(-1)).toBe(`skill-${SKILLS_KEPT - 1}`);
  });
});

describe('the floor of a group', () => {
  // office-building-floors spec, Example: 依技能決定樓層
  it.each([
    [[], 1],
    [['speclink-apply'], 5],
    [['speclink-apply', 'speclink-analyze'], 5],
    [['speclink-apply', 'speclink-review'], 6],
    [['speclink-review', 'speclink-apply'], 5],
    [['speclink-analyze'], 1],
    [['spectra-discuss'], 3],
  ] as const)('skills %j → %iF', (skills, level) => {
    expect(levelForSkills(skills, DEFAULT_CONFIG)).toBe(level);
  });

  // office-building-floors spec, Scenario: 換技能換樓層 / office-session-groups spec, Scenario: 一個對話卡在等核准
  it('puts each group on its floor, counts groups per floor, and keeps one stats bar per building', () => {
    const store = new OfficeStore();
    const T0 = Date.now();
    const ev = (sessionId: string, kind: OfficeEvent['kind'], extra: Partial<OfficeEvent> = {}) =>
      store.apply({ kind, source: 'observe', sessionId, actorId: mainActorId(sessionId), cwd: 'D:\\work\\app', at: T0, ...extra });
    ev('lobby', 'turn.start');
    ev('lobby', 'tool.start', { tool: 'Bash', toolUseId: 'b1' });
    ev('a', 'skill.use', { skill: 'speclink-apply' });
    ev('a', 'turn.start');
    ev('a', 'tool.start', { tool: 'Bash', toolUseId: 'b2' });
    ev('b', 'skill.use', { skill: 'speclink-apply' });
    ev('b', 'waiting');

    const view = buildView(store, TWO_BUILDINGS, T0 + 1);
    const levelOf = (s: string) => view.groups.find((g) => g.sessionId === s)!.level;
    expect([levelOf('lobby'), levelOf('a'), levelOf('b')]).toEqual([1, 5, 5]);
    const work = view.buildings.find((b) => b.name === '工作樓')!;
    expect(work.levels.find((l) => l.level === 1)!.groups).toBe(1);
    expect(work.levels.find((l) => l.level === 5)!.groups).toBe(2);
    expect(work.levels.reduce((n, l) => n + l.groups, 0)).toBe(3);
    expect(work.stats).toMatchObject({ working: 2, waiting: 1 });

    ev('a', 'skill.use', { skill: 'speclink-review' });
    expect(buildView(store, TWO_BUILDINGS, T0 + 2).groups.find((g) => g.sessionId === 'a')!.level).toBe(6);
  });
});
