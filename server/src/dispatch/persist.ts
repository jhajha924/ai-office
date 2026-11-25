import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Dispatch } from './types.ts';

/**
 * Dispatch records on disk: ~/.ai-office/projects/<id>/dispatch.json, one
 * file per dispatch, rewritten whole on every change (temp file + rename so a
 * crash never leaves half a file). Local only, never uploaded.
 */

export const DISPATCH_FILE = 'dispatch.json';

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.ai-office', 'projects');
}

export interface DispatchStorage {
  save(dispatch: Dispatch): void;
  loadAll(): Dispatch[];
}

const PROJECT_STATUSES = new Set(['planning', 'confirm', 'queued', 'cancelled', 'running', 'waiting', 'done', 'stopped']);
const DECISION_KINDS = new Set(['confirm', 'retry', 'question', 'stuck', 'rejected', 'blocked', 'qa']);

/** A status or kind this version does not know means a file it cannot run safely. */
function knownParts(d: Record<string, unknown>): boolean {
  const projects = d.projects as unknown[];
  const decisions = d.decisions as unknown[];
  return (
    projects.every((p) => !!p && typeof p === 'object' && PROJECT_STATUSES.has((p as Record<string, unknown>).status as string)) &&
    decisions.every((q) => !!q && typeof q === 'object' && DECISION_KINDS.has((q as Record<string, unknown>).kind as string))
  );
}

function looksLikeDispatch(value: unknown): value is Dispatch {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    /^d\d{8}-\d{3}$/.test(d.id) &&
    typeof d.text === 'string' &&
    typeof d.building === 'string' &&
    typeof d.status === 'string' &&
    Array.isArray(d.projects) &&
    Array.isArray(d.decisions) &&
    Array.isArray(d.calls) &&
    knownParts(d)
  );
}

export function fileStorage(root: string, warn: (message: string) => void): DispatchStorage {
  return {
    save(dispatch) {
      const dir = path.join(root, dispatch.id);
      const file = path.join(dir, DISPATCH_FILE);
      const temp = `${file}.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(temp, JSON.stringify(dispatch, null, 2), 'utf-8');
        fs.renameSync(temp, file);
      } catch (err) {
        warn(`[AI 辦公室] 交辦 ${dispatch.id} 存檔失敗（${(err as NodeJS.ErrnoException).code ?? '寫不進去'}），先只記在記憶體`);
      }
    },
    loadAll() {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch {
        return [];
      }
      const out: Dispatch[] = [];
      for (const name of names.sort()) {
        const file = path.join(root, name, DISPATCH_FILE);
        if (!fs.existsSync(file)) continue;
        try {
          const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
          if (!looksLikeDispatch(value) || value.id !== name) throw new Error('shape');
          out.push(value);
        } catch {
          // Never echo the file's text: it holds the user's request and paths.
          warn(`[AI 辦公室] 交辦紀錄 ${name} 讀不懂，已略過`);
        }
      }
      return out;
    },
  };
}
