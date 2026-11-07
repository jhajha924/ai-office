import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Office settings: floor rules, the staff roster and timing thresholds.
 *
 * Read from ~/.ai-office/config.json, never written. A missing key takes its
 * built-in default, but any present key with the wrong shape makes the whole
 * file fall back to the built-in defaults, so a half-valid file can never
 * route sessions to a floor nobody configured.
 */

export interface FloorRule {
  /** Path prefix, matched on folder boundaries after normalization. */
  prefix: string;
  /** Floor name the matching sessions are shown on. */
  floor: string;
  /** Hide file names, commands and subtask descriptions in status bubbles. */
  mask: boolean;
}

export interface FloorTarget {
  floor: string;
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

export interface OfficeConfig {
  floors: { rules: FloorRule[]; default: FloorTarget };
  roster: Roster;
  /** Per-floor title overrides, keyed by floor name. */
  floorOverrides: Record<string, Partial<RosterTitles>>;
  groupLabelMaxChars: number;
  timing: Timing;
  observe: ObserveSettings;
  port?: number;
}

const MINUTE = 60_000;

export const DEFAULT_CONFIG: OfficeConfig = {
  floors: {
    // No one's folders are built in: without a config file every session
    // shares one unmasked floor. config.example.json shows two floors.
    rules: [],
    default: { floor: '辦公室', mask: false },
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
  floorOverrides: {},
  groupLabelMaxChars: 15,
  timing: {
    stuckRunningMs: 10 * MINUTE,
    stuckThinkingMs: 8 * MINUTE,
    idleAfterDoneMs: 3 * MINUTE,
    dozeAfterIdleMs: 15 * MINUTE,
    groupLeaveMs: 30 * MINUTE,
  },
  observe: { sources: ['claude-code'] },
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

function parseFloorTarget(value: unknown, field: string): FloorTarget {
  if (!isPlainObject(value)) throw new ShapeError(field);
  if (typeof value.mask !== 'boolean') throw new ShapeError(`${field}.mask`);
  return { floor: nonEmptyString(value.floor, `${field}.floor`), mask: value.mask };
}

function parseFloors(value: unknown): OfficeConfig['floors'] {
  const defaults = DEFAULT_CONFIG.floors;
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) throw new ShapeError('floors');
  let rules = defaults.rules;
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) throw new ShapeError('floors.rules');
    rules = value.rules.map((rule, i) => ({
      ...parseFloorTarget(rule, `floors.rules[${i}]`),
      prefix: nonEmptyString((rule as Record<string, unknown>).prefix, `floors.rules[${i}].prefix`),
    }));
  }
  const fallback =
    value.default === undefined ? defaults.default : parseFloorTarget(value.default, 'floors.default');
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

function parseFloorOverrides(value: unknown): OfficeConfig['floorOverrides'] {
  if (value === undefined) return DEFAULT_CONFIG.floorOverrides;
  if (!isPlainObject(value)) throw new ShapeError('floorOverrides');
  const out: OfficeConfig['floorOverrides'] = {};
  for (const [floor, titles] of Object.entries(value)) {
    if (!isPlainObject(titles)) throw new ShapeError(`floorOverrides.${floor}`);
    const entry: Partial<RosterTitles> = {};
    if (titles.subagents !== undefined) {
      entry.subagents = stringMap(titles.subagents, `floorOverrides.${floor}.subagents`);
    }
    if (titles.skills !== undefined) {
      entry.skills = stringMap(titles.skills, `floorOverrides.${floor}.skills`);
    }
    out[floor] = entry;
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

/** Validate a parsed config.json. Throws ShapeError naming the first bad field. */
export function parseConfig(raw: unknown): OfficeConfig {
  if (!isPlainObject(raw)) throw new ShapeError('(root)');
  const config: OfficeConfig = {
    floors: parseFloors(raw.floors),
    roster: parseRoster(raw.roster),
    floorOverrides: parseFloorOverrides(raw.floorOverrides),
    groupLabelMaxChars:
      raw.groupLabelMaxChars === undefined
        ? DEFAULT_CONFIG.groupLabelMaxChars
        : positiveInt(raw.groupLabelMaxChars, 'groupLabelMaxChars'),
    timing: parseTiming(raw.timing),
    observe: parseObserve(raw.observe),
  };
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
