import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { Progress } from '../office/types.ts';
import type { ChangeHint } from './transcriptParser.ts';

/**
 * Progress of the speclink / spectra change a session works on: the ratio of
 * checked boxes in its tasks.md. Only ever called for sessions on an unmasked
 * floor — the watcher decides that; this module just reads and counts.
 */

const DONE = /^\s*- \[[xX]\]/;
const OPEN = /^\s*- \[ \]/;

/** done / total of a tasks.md text; undefined when it has no task boxes. */
export function countTasks(text: string): Progress | undefined {
  let done = 0;
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (DONE.test(line)) {
      done += 1;
      total += 1;
    } else if (OPEN.test(line)) {
      total += 1;
    }
  }
  return total > 0 ? { done, total } : undefined;
}

/** Where a change's tasks.md lives: the folder a file path named, else <start cwd>/openspec/changes/<name>. */
export function tasksPath(change: ChangeHint, startCwd: string): string {
  return path.join(change.dir ?? path.join(startCwd, 'openspec', 'changes', change.name), 'tasks.md');
}

/**
 * Re-reads tasks.md only when its path, modification time or size moved
 * since `lastStamp`. Returns undefined when nothing moved; otherwise the new
 * stamp and the progress (undefined progress = cannot tell, e.g. the file is gone).
 */
export async function readProgress(
  file: string,
  lastStamp: string | undefined,
): Promise<{ stamp: string; progress: Progress | undefined } | undefined> {
  let stamp: string;
  try {
    const stat = await fsp.stat(file);
    stamp = `${file}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    stamp = `${file}|missing`;
    return stamp === lastStamp ? undefined : { stamp, progress: undefined };
  }
  if (stamp === lastStamp) return undefined;
  try {
    return { stamp, progress: countTasks(await fsp.readFile(file, 'utf-8')) };
  } catch {
    return { stamp: `${file}|unreadable`, progress: undefined };
  }
}
