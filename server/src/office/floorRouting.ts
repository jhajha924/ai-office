import type { BuildingTarget, OfficeConfig } from './config.ts';

/**
 * Building routing: which building a session is shown on, from its cwd.
 *
 * The longest building-rule prefix wins; otherwise the default building. The rules
 * are Windows paths in practice, so comparison is platform-independent:
 * separators unified, case folded, trailing separator dropped, and a prefix
 * only matches on a folder boundary (D:\work never claims D:\workX).
 */

/** Comparison key for a building path: `/` separators, lowercase, no trailing `/`. */
export function normalizeBuildingPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isWithin(key: string, prefixKey: string): boolean {
  return key === prefixKey || key.startsWith(`${prefixKey}/`);
}

/** Building for a cwd: the longest matching rule prefix, else the default. */
export function buildingForCwd(cwd: string, config: OfficeConfig): BuildingTarget {
  const key = normalizeBuildingPath(cwd);
  let best: { length: number; target: BuildingTarget } | null = null;
  for (const rule of config.buildings.rules) {
    const prefixKey = normalizeBuildingPath(rule.prefix);
    if (prefixKey.length > 0 && isWithin(key, prefixKey)) {
      if (!best || prefixKey.length > best.length) {
        best = { length: prefixKey.length, target: { building: rule.building, mask: rule.mask } };
      }
    }
  }
  return best ? best.target : config.buildings.default;
}

/** Claude Code's project folder name for a path: every non-alphanumeric character becomes `-`. */
export function projectDirName(dirPath: string): string {
  return dirPath.trim().replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Building for a session known only by its project folder name (d--work-app).
 * The name folds separators and non-ASCII characters to `-`, so this is a
 * best effort, used only until the transcript head tells the real start cwd.
 */
export function buildingForProjectDir(dirName: string, config: OfficeConfig): BuildingTarget {
  const target = dirName.toLowerCase();
  let best: { length: number; target: BuildingTarget } | null = null;
  for (const rule of config.buildings.rules) {
    const key = projectDirName(rule.prefix).toLowerCase();
    if (key.length > 0 && (target === key || target.startsWith(`${key}-`))) {
      if (!best || key.length > best.length) best = { length: key.length, target: { building: rule.building, mask: rule.mask } };
    }
  }
  return best ? best.target : config.buildings.default;
}

/**
 * A session's building comes from where it was started — the first cwd in its
 * transcript — never from a later cwd: a work session that moves into a temp
 * folder must stay on the masked building. Before that is known, the project
 * folder name decides; a session with neither falls back to its latest cwd.
 */
export function buildingForSession(home: SessionHome | undefined, latestCwd: string, config: OfficeConfig): BuildingTarget {
  if (home?.cwd) return buildingForCwd(home.cwd, config);
  if (home?.projectDir) return buildingForProjectDir(home.projectDir, config);
  return buildingForCwd(latestCwd, config);
}

export interface SessionHome {
  /** The first cwd recorded in the transcript. */
  cwd?: string;
  /** The transcript's folder under ~/.claude/projects. */
  projectDir?: string;
}

/** Every building the config names, in rule order, the default building last if new. */
export function buildingList(config: OfficeConfig): BuildingTarget[] {
  const out: BuildingTarget[] = [];
  for (const target of [...config.buildings.rules, config.buildings.default]) {
    if (!out.some((f) => f.building === target.building)) out.push({ building: target.building, mask: target.mask });
  }
  return out;
}
