import type { FloorTarget, OfficeConfig } from './config.ts';

/**
 * Floor routing: which floor a session is shown on, from its cwd.
 *
 * The longest floor-rule prefix wins; otherwise the default floor. The rules
 * are Windows paths in practice, so comparison is platform-independent:
 * separators unified, case folded, trailing separator dropped, and a prefix
 * only matches on a folder boundary (D:\work never claims D:\workX).
 */

/** Comparison key for a floor path: `/` separators, lowercase, no trailing `/`. */
export function normalizeFloorPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isWithin(key: string, prefixKey: string): boolean {
  return key === prefixKey || key.startsWith(`${prefixKey}/`);
}

/** Floor for a cwd: the longest matching rule prefix, else the default. */
export function floorForCwd(cwd: string, config: OfficeConfig): FloorTarget {
  const key = normalizeFloorPath(cwd);
  let best: { length: number; target: FloorTarget } | null = null;
  for (const rule of config.floors.rules) {
    const prefixKey = normalizeFloorPath(rule.prefix);
    if (prefixKey.length > 0 && isWithin(key, prefixKey)) {
      if (!best || prefixKey.length > best.length) {
        best = { length: prefixKey.length, target: { floor: rule.floor, mask: rule.mask } };
      }
    }
  }
  return best ? best.target : config.floors.default;
}

/** Claude Code's project folder name for a path: every non-alphanumeric character becomes `-`. */
export function projectDirName(dirPath: string): string {
  return dirPath.trim().replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Floor for a session known only by its project folder name (d--work-app).
 * The name folds separators and non-ASCII characters to `-`, so this is a
 * best effort, used only until the transcript head tells the real start cwd.
 */
export function floorForProjectDir(dirName: string, config: OfficeConfig): FloorTarget {
  const target = dirName.toLowerCase();
  let best: { length: number; target: FloorTarget } | null = null;
  for (const rule of config.floors.rules) {
    const key = projectDirName(rule.prefix).toLowerCase();
    if (key.length > 0 && (target === key || target.startsWith(`${key}-`))) {
      if (!best || key.length > best.length) best = { length: key.length, target: { floor: rule.floor, mask: rule.mask } };
    }
  }
  return best ? best.target : config.floors.default;
}

/**
 * A session's floor comes from where it was started — the first cwd in its
 * transcript — never from a later cwd: a work session that moves into a temp
 * folder must stay on the masked floor. Before that is known, the project
 * folder name decides; a session with neither falls back to its latest cwd.
 */
export function floorForSession(home: SessionHome | undefined, latestCwd: string, config: OfficeConfig): FloorTarget {
  if (home?.cwd) return floorForCwd(home.cwd, config);
  if (home?.projectDir) return floorForProjectDir(home.projectDir, config);
  return floorForCwd(latestCwd, config);
}

export interface SessionHome {
  /** The first cwd recorded in the transcript. */
  cwd?: string;
  /** The transcript's folder under ~/.claude/projects. */
  projectDir?: string;
}

/** Every floor the config names, in rule order, the default floor last if new. */
export function floorList(config: OfficeConfig): FloorTarget[] {
  const out: FloorTarget[] = [];
  for (const target of [...config.floors.rules, config.floors.default]) {
    if (!out.some((f) => f.floor === target.floor)) out.push({ floor: target.floor, mask: target.mask });
  }
  return out;
}
