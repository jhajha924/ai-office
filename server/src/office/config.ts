import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DepartmentTheme } from './types.ts';

/**
 * Office settings: building rules, the staff roster and timing thresholds.
 *
 * Read from ~/.ai-office/config.json, never written. A missing key takes its
 * built-in default, but any present key with the wrong shape makes the whole
 * file fall back to the built-in defaults, so a half-valid file can never
 * route sessions to a building nobody configured.
 */

export interface BuildingRule {
  /** Path prefix, matched on folder boundaries after normalization. */
  prefix: string;
  /** Building name the matching sessions are shown on. */
  building: string;
  /** Hide file names, commands and subtask descriptions in status bubbles. */
  mask: boolean;
}

export interface BuildingTarget {
  building: string;
  mask: boolean;
}

export interface RosterTitles {
  subagents: Record<string, string>;
  skills: Record<string, string>;
}

export interface Roster extends RosterTitles {
  /** `{name}` is replaced with the MCP server segment of mcp__<name>__<tool>. */
  mcpTemplate: string;
  fallbackSubagent: string;
  /** `{name}` is replaced with the skill name. */
  fallbackSkill: string;
  /** Employee names, picked by a hash of the actor id. At least one. */
  names: string[];
}

export interface Timing {
  /** Running this long without a new event marks the employee "卡住？". */
  stuckRunningMs: number;
  stuckThinkingMs: number;
  /** Done this long turns into idle. */
  idleAfterDoneMs: number;
  /** Idle this much longer turns into dozing. */
  dozeAfterIdleMs: number;
  /** A transcript silent this long takes its group out of the office. */
  groupLeaveMs: number;
}

export interface ObserveSettings {
  /** Ids of the observe sources started with the server (read at start-up only). */
  sources: string[];
}

/** A department: one floor of every building, holding the sessions whose current skill is one of its skills. */
export interface Department {
  id: string;
  name: string;
  /** 3 and up: floors 1 and 2 are the lobby and the managers' floor. */
  floor: number;
  skills: string[];
  /** How its floor looks; when omitted, see levelList. */
  theme?: DepartmentTheme;
}

/** The five department styles, in the order departments without a theme take them. */
export const DEPARTMENT_THEMES: readonly DepartmentTheme[] = ['analysis', 'spec', 'build', 'qa', 'release'];

/** The lowest and highest floor a department can be on. */
export const DEPARTMENT_FLOOR_MIN = 3;
export const DEPARTMENT_FLOOR_MAX = 99;

/** Where dispatch (交辦) may start work; absent = dispatch is off. */
export interface DispatchSettings {
  /** The one building dispatch works on: a configured, unmasked building. */
  building: string;
  /** Code projects must live in a folder under this root. */
  workRoot: string;
  models: { president: string; manager: string };
  /** Explicit claude executable; otherwise it is looked up on PATH. */
  claudePath?: string;
}

export const DEFAULT_DISPATCH_MODELS: DispatchSettings['models'] = { president: 'opus', manager: 'sonnet' };

export interface OfficeConfig {
  buildings: { rules: BuildingRule[]; default: BuildingTarget };
  roster: Roster;
  /** Per-building title overrides, keyed by building name. */
  buildingOverrides: Record<string, Partial<RosterTitles>>;
  groupLabelMaxChars: number;
  timing: Timing;
  observe: ObserveSettings;
  departments: Department[];
  dispatch?: DispatchSettings;
  port?: number;
}

const MINUTE = 60_000;

export const DEFAULT_CONFIG: OfficeConfig = {
  buildings: {
    // No one's folders are built in: without a config file every session
    // shares one unmasked building. config.example.json shows two buildings.
    rules: [],
    default: { building: '辦公室', mask: false },
  },
  roster: {
    subagents: { Explore: '資料調查員', Plan: '系統架構師', 'general-purpose': '支援專員' },
    skills: {
      'speclink-discuss': '需求顧問',
      'speclink-propose': '規格企劃',
      'speclink-apply': '開發工程師',
      'speclink-review': '品管工程師',
      'speclink-verify': '驗收員',
      'speclink-audit': '資安稽核',
      'speclink-archive': '文件管理員',
      'speclink-commit': '版控專員',
    },
    mcpTemplate: '{name} 外包窗口',
    fallbackSubagent: '支援專員',
    fallbackSkill: '{name} 專員',
    names: ['阿哲', '小安', '阿凱', '小芸', '阿翔', '小婷', '阿傑', '小涵', '阿豪', '小琪', '阿宏', '小萱', '阿偉', '小晴', '阿明', '小雯', '阿誠', '小柔', '阿宇', '小瑜', '阿昇', '小蓁', '阿峰', '小綾', '阿正', '小慧', '阿廷', '小薇', '阿勳', '小芃', '阿睿', '小嵐', '阿霖', '小妍', '阿璋', '小葳', '阿杰', '小恩', '阿彥', '小筑'],
  },
  buildingOverrides: {},
  groupLabelMaxChars: 15,
  timing: {
    stuckRunningMs: 10 * MINUTE,
    stuckThinkingMs: 8 * MINUTE,
    idleAfterDoneMs: 3 * MINUTE,
    dozeAfterIdleMs: 15 * MINUTE,
    groupLeaveMs: 30 * MINUTE,
  },
  observe: { sources: ['claude-code'] },
  departments: [
    { id: 'analysis', name: '需求分析組', floor: 3, skills: ['speclink-discuss', 'spectra-discuss'] },
    {
      id: 'spec',
      name: '規格企劃組',
      floor: 4,
      skills: ['speclink-propose', 'speclink-ingest', 'spectra-propose', 'spectra-ingest'],
    },
    { id: 'build', name: '工程組', floor: 5, skills: ['speclink-apply', 'spectra-apply'] },
    {
      id: 'qa',
      name: '測試品管組',
      floor: 6,
      skills: ['speclink-review', 'speclink-verify', 'speclink-audit', 'speclink-quality', 'spectra-verify', 'spectra-audit'],
    },
    {
      id: 'release',
      name: '文件發佈組',
      floor: 7,
      skills: ['speclink-archive', 'speclink-commit', 'spectra-archive', 'spectra-commit'],
    },
  ],
};

/** Thrown internally when a present key has the wrong shape. */
class ShapeError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ShapeError(field);
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ShapeError(field);
  }
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!isPlainObject(value)) throw new ShapeError(field);
  const out: Record<string, string> = {};
  for (const [key, title] of Object.entries(value)) {
    out[key] = nonEmptyString(title, `${field}.${key}`);
  }
  return out;
}

/**
 * The config file names buildings with the keys `buildings` / `building`; the
 * older keys `floors` / `floor` (from before buildings had floors of their
 * own) are still read when the new ones are absent.
 */
type BuildingKeys = { section: 'buildings'; name: 'building' } | { section: 'floors'; name: 'floor' };
const NEW_KEYS: BuildingKeys = { section: 'buildings', name: 'building' };
const OLD_KEYS: BuildingKeys = { section: 'floors', name: 'floor' };

function parseBuildingTarget(value: unknown, field: string, keys: BuildingKeys): BuildingTarget {
  if (!isPlainObject(value)) throw new ShapeError(field);
  if (typeof value.mask !== 'boolean') throw new ShapeError(`${field}.mask`);
  return { building: nonEmptyString(value[keys.name], `${field}.${keys.name}`), mask: value.mask };
}

function parseBuildings(value: unknown, keys: BuildingKeys): OfficeConfig['buildings'] {
  const defaults = DEFAULT_CONFIG.buildings;
  const at = keys.section;
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) throw new ShapeError(at);
  let rules = defaults.rules;
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) throw new ShapeError(`${at}.rules`);
    rules = value.rules.map((rule, i) => ({
      ...parseBuildingTarget(rule, `${at}.rules[${i}]`, keys),
      prefix: nonEmptyString((rule as Record<string, unknown>).prefix, `${at}.rules[${i}].prefix`),
    }));
  }
  const fallback =
    value.default === undefined ? defaults.default : parseBuildingTarget(value.default, `${at}.default`, keys);
  return { rules, default: fallback };
}

function parseRoster(value: unknown): Roster {
  const defaults = DEFAULT_CONFIG.roster;
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) throw new ShapeError('roster');
  const pick = (key: 'mcpTemplate' | 'fallbackSubagent' | 'fallbackSkill'): string =>
    value[key] === undefined ? defaults[key] : nonEmptyString(value[key], `roster.${key}`);
  return {
    subagents:
      value.subagents === undefined ? defaults.subagents : stringMap(value.subagents, 'roster.subagents'),
    skills: value.skills === undefined ? defaults.skills : stringMap(value.skills, 'roster.skills'),
    mcpTemplate: pick('mcpTemplate'),
    fallbackSubagent: pick('fallbackSubagent'),
    fallbackSkill: pick('fallbackSkill'),
    names: value.names === undefined ? defaults.names : nameList(value.names),
  };
}

function nameList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ShapeError('roster.names');
  return value.map((name, i) => nonEmptyString(name, `roster.names[${i}]`));
}

function parseBuildingOverrides(value: unknown, at: 'buildingOverrides' | 'floorOverrides'): OfficeConfig['buildingOverrides'] {
  if (value === undefined) return DEFAULT_CONFIG.buildingOverrides;
  if (!isPlainObject(value)) throw new ShapeError(at);
  const out: OfficeConfig['buildingOverrides'] = {};
  for (const [building, titles] of Object.entries(value)) {
    if (!isPlainObject(titles)) throw new ShapeError(`${at}.${building}`);
    const entry: Partial<RosterTitles> = {};
    if (titles.subagents !== undefined) {
      entry.subagents = stringMap(titles.subagents, `${at}.${building}.subagents`);
    }
    if (titles.skills !== undefined) {
      entry.skills = stringMap(titles.skills, `${at}.${building}.skills`);
    }
    out[building] = entry;
  }
  return out;
}

function parseTiming(value: unknown): Timing {
  const defaults = DEFAULT_CONFIG.timing;
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) throw new ShapeError('timing');
  const pick = (key: keyof Timing): number =>
    value[key] === undefined ? defaults[key] : positiveInt(value[key], `timing.${key}`);
  return {
    stuckRunningMs: pick('stuckRunningMs'),
    stuckThinkingMs: pick('stuckThinkingMs'),
    idleAfterDoneMs: pick('idleAfterDoneMs'),
    dozeAfterIdleMs: pick('dozeAfterIdleMs'),
    groupLeaveMs: pick('groupLeaveMs'),
  };
}

function parseObserve(value: unknown): ObserveSettings {
  if (value === undefined) return DEFAULT_CONFIG.observe;
  if (!isPlainObject(value)) throw new ShapeError('observe');
  if (value.sources === undefined) return DEFAULT_CONFIG.observe;
  if (!Array.isArray(value.sources)) throw new ShapeError('observe.sources');
  return { sources: value.sources.map((id, i) => nonEmptyString(id, `observe.sources[${i}]`)) };
}

function parseDepartments(value: unknown): Department[] {
  if (value === undefined) return DEFAULT_CONFIG.departments;
  if (!Array.isArray(value)) throw new ShapeError('departments');
  const ids = new Set<string>();
  const floors = new Set<number>();
  const skills = new Set<string>();
  return value.map((item, i) => {
    const at = `departments[${i}]`;
    if (!isPlainObject(item)) throw new ShapeError(at);
    const id = nonEmptyString(item.id, `${at}.id`);
    const name = nonEmptyString(item.name, `${at}.name`);
    const floor = item.floor;
    if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < DEPARTMENT_FLOOR_MIN || floor > DEPARTMENT_FLOOR_MAX) {
      throw new ShapeError(`${at}.floor`);
    }
    if (!Array.isArray(item.skills) || item.skills.length === 0) throw new ShapeError(`${at}.skills`);
    const own = item.skills.map((skill, j) => nonEmptyString(skill, `${at}.skills[${j}]`));
    if (ids.has(id)) throw new ShapeError(`${at}.id`);
    if (floors.has(floor)) throw new ShapeError(`${at}.floor`);
    for (const [j, skill] of own.entries()) {
      if (skills.has(skill)) throw new ShapeError(`${at}.skills[${j}]`);
      skills.add(skill);
    }
    let theme: DepartmentTheme | undefined;
    if (item.theme !== undefined) {
      if (typeof item.theme !== 'string' || !(DEPARTMENT_THEMES as readonly string[]).includes(item.theme)) {
        throw new ShapeError(`${at}.theme`);
      }
      theme = item.theme as DepartmentTheme;
    }
    ids.add(id);
    floors.add(floor);
    return { id, name, floor, skills: own, ...(theme ? { theme } : {}) };
  });
}

function parseDispatch(value: unknown, buildings: OfficeConfig['buildings']): DispatchSettings {
  if (!isPlainObject(value)) throw new ShapeError('dispatch');
  const building = nonEmptyString(value.building, 'dispatch.building');
  // Only a building the config actually has, and never a masked one.
  const target = [...buildings.rules, buildings.default].find((b) => b.building === building);
  if (!target || target.mask) throw new ShapeError('dispatch.building');
  const workRoot = nonEmptyString(value.workRoot, 'dispatch.workRoot');
  let models = DEFAULT_DISPATCH_MODELS;
  if (value.models !== undefined) {
    if (!isPlainObject(value.models)) throw new ShapeError('dispatch.models');
    const pick = (key: 'president' | 'manager'): string =>
      value.models === undefined || (value.models as Record<string, unknown>)[key] === undefined
        ? DEFAULT_DISPATCH_MODELS[key]
        : nonEmptyString((value.models as Record<string, unknown>)[key], `dispatch.models.${key}`);
    models = { president: pick('president'), manager: pick('manager') };
  }
  const out: DispatchSettings = { building, workRoot, models };
  if (value.claudePath !== undefined) out.claudePath = nonEmptyString(value.claudePath, 'dispatch.claudePath');
  return out;
}

/** Validate a parsed config.json. Throws ShapeError naming the first bad field. */
export function parseConfig(raw: unknown): OfficeConfig {
  if (!isPlainObject(raw)) throw new ShapeError('(root)');
  const config: OfficeConfig = {
    buildings:
      raw.buildings !== undefined ? parseBuildings(raw.buildings, NEW_KEYS) : parseBuildings(raw.floors, OLD_KEYS),
    roster: parseRoster(raw.roster),
    buildingOverrides:
      raw.buildingOverrides !== undefined
        ? parseBuildingOverrides(raw.buildingOverrides, 'buildingOverrides')
        : parseBuildingOverrides(raw.floorOverrides, 'floorOverrides'),
    groupLabelMaxChars:
      raw.groupLabelMaxChars === undefined
        ? DEFAULT_CONFIG.groupLabelMaxChars
        : positiveInt(raw.groupLabelMaxChars, 'groupLabelMaxChars'),
    timing: parseTiming(raw.timing),
    observe: parseObserve(raw.observe),
    departments: parseDepartments(raw.departments),
  };
  if (raw.dispatch !== undefined) config.dispatch = parseDispatch(raw.dispatch, config.buildings);
  if (raw.port !== undefined) {
    const port = positiveInt(raw.port, 'port');
    if (port > 65535) throw new ShapeError('port');
    config.port = port;
  }
  return config;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.ai-office', 'config.json');
}

export interface ConfigSource {
  /** The current config; re-reads the file when its mtime or size changed. */
  get(): OfficeConfig;
}

/**
 * A missing file silently yields the built-in defaults; an unreadable,
 * non-JSON or wrongly shaped file logs one warning and yields the defaults,
 * so the office keeps running. The file is looked at again at most every
 * `checkIntervalMs`, so an edit applies within that time without a restart.
 */
export function createConfigSource(
  filePath: string = defaultConfigPath(),
  options: { checkIntervalMs?: number; now?: () => number; warn?: (message: string) => void } = {},
): ConfigSource {
  const checkIntervalMs = options.checkIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let config = DEFAULT_CONFIG;
  let stamp: string | null = null;
  let checkedAt = -Infinity;

  function refresh(): void {
    let next: string;
    try {
      const stat = fs.statSync(filePath);
      next = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = null;
      config = DEFAULT_CONFIG;
      return;
    }
    if (next === stamp) return;
    stamp = next;
    try {
      config = parseConfig(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch (err) {
      // Never echo the error message itself: JSON.parse quotes the file's text.
      const reason =
        err instanceof ShapeError
          ? `欄位 ${err.message} 格式不對`
          : err instanceof SyntaxError
            ? '不是合法的 JSON'
            : ((err as NodeJS.ErrnoException).code ?? '讀不到');
      warn(`[AI 辦公室] 設定檔 ${filePath} 已略過（${reason}），改用內建預設`);
      config = DEFAULT_CONFIG;
    }
  }

  return {
    get() {
      const t = now();
      if (t - checkedAt >= checkIntervalMs) {
        checkedAt = t;
        refresh();
      }
      return config;
    },
  };
}
