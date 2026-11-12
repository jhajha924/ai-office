import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DispatchSettings } from '../office/config.ts';

/**
 * Finding the claude and speclink executables, and the start-up check that
 * decides whether dispatch can be offered at all. Nothing here ever runs
 * through a shell: a .cmd shim is never executed, the real binary behind it
 * is looked up instead.
 */

export type DispatchStatus = 'off' | 'ready' | 'missing-claude' | 'missing-speclink';

export interface LookupEnv {
  /** The PATH value; split on path.delimiter for the platform. */
  pathEnv: string;
  platform: NodeJS.Platform;
  isFile: (file: string) => boolean;
}

export const VERSION_TIMEOUT_MS = 10_000;

export function defaultLookupEnv(): LookupEnv {
  return {
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    platform: process.platform,
    isFile: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
  };
}

function pathDirs(env: LookupEnv): string[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  return env.pathEnv.split(env.platform === 'win32' ? ';' : ':').filter((d) => d.length > 0).map((d) => p.normalize(d));
}

/** A plain executable on PATH: name.exe on Windows, name elsewhere. */
export function findOnPath(name: string, env: LookupEnv): string | undefined {
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  const file = env.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of pathDirs(env)) {
    const candidate = p.join(dir, file);
    if (env.isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * claude: the configured claudePath, then claude(.exe) on PATH, then the
 * claude.exe that an npm claude.cmd shim on PATH launches.
 */
export function findClaude(claudePath: string | undefined, env: LookupEnv): string | undefined {
  if (claudePath !== undefined) return env.isFile(claudePath) ? claudePath : undefined;
  const direct = findOnPath('claude', env);
  if (direct) return direct;
  if (env.platform !== 'win32') return undefined;
  for (const dir of pathDirs(env)) {
    if (!env.isFile(path.win32.join(dir, 'claude.cmd'))) continue;
    const binary = path.win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (env.isFile(binary)) return binary;
  }
  return undefined;
}

export function findSpeclink(env: LookupEnv): string | undefined {
  return findOnPath('speclink', env);
}

/** Runs `<file> --version` without a shell; true when it exits 0 in time. */
export type VersionCheck = (file: string) => Promise<boolean>;

export const runVersion: VersionCheck = (file) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, ['--version'], { shell: false, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, VERSION_TIMEOUT_MS);
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });

export interface Availability {
  status: DispatchStatus;
  claude?: string;
  speclink?: string;
}

/** The start-up check: off without settings, otherwise both tools must answer --version. */
export async function checkAvailability(
  settings: DispatchSettings | undefined,
  env: LookupEnv = defaultLookupEnv(),
  check: VersionCheck = runVersion,
): Promise<Availability> {
  if (!settings) return { status: 'off' };
  const claude = findClaude(settings.claudePath, env);
  const speclink = findSpeclink(env);
  const [claudeOk, speclinkOk] = await Promise.all([
    claude ? check(claude) : Promise.resolve(false),
    speclink ? check(speclink) : Promise.resolve(false),
  ]);
  if (!claudeOk) return { status: 'missing-claude' };
  if (!speclinkOk) return { status: 'missing-speclink' };
  return { status: 'ready', claude, speclink };
}
