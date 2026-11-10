import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConfigSource, OfficeConfig } from '../office/config.ts';
import { buildingForSession } from '../office/floorRouting.ts';
import { firstUserMessage, LABEL_HEAD_LINES, latestTitle, shortenLabel } from '../office/groupLabel.ts';
import type { OfficeStore } from '../office/store.ts';
import { mainActorId } from '../office/types.ts';
import { readProgress, tasksPath } from './changeProgress.ts';
import type { ChangeHint, ToolNames } from './transcriptParser.ts';
import { parseLine } from './transcriptParser.ts';

/**
 * Read-only watcher of Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl).
 *
 * Polls every 2 seconds instead of fs.watch, which is unreliable on Windows
 * for deep folders. Each file remembers how far it has been read, so only new
 * bytes are parsed; a trailing piece without a newline (a line still being
 * written) waits for the next round. Bytes are split on the newline byte
 * before decoding, so a multi-byte character cut by a read is never mangled.
 *
 * Nothing here opens a file for writing. The projects' own folders (the
 * sessions' cwd) are never read, with one exception on unmasked buildings only:
 * the tasks.md of the change a session works on, for its progress bar.
 */

export const SCAN_INTERVAL_MS = 2_000;
/** On start-up, how much of a transcript's tail rebuilds the current state. */
export const STARTUP_TAIL_BYTES = 256 * 1024;
/** How much of a transcript's head is read to find the group label. */
const HEAD_BYTES = 256 * 1024;
/** How often a transcript without a label yet is looked at again. */
const LABEL_RETRY_MS = 5_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

interface FileState {
  sessionId: string;
  offset: number;
  /** Bytes after the last newline, waiting for the rest of their line. */
  partial: Buffer;
  /** True while the bytes before the first newline belong to a line cut by a tail start. */
  dropFirstLine: boolean;
  toolNames: ToolNames;
  lastCwd: string;
  /** Latest title read past the head (start-up tail or new lines): the newest there is. */
  streamTitle?: string;
  /** From the transcript head: the latest title in it and the first user message. */
  headTitle?: string;
  firstMessage?: string;
  labelTriedAt: number;
  /** The first cwd of the transcript has been found (it fixes the building). */
  homeKnown: boolean;
  /** The change the session was last seen working on. */
  change?: ChangeHint;
  /** tasks.md path, mtime and size last read, so an unchanged file is not read again. */
  progressStamp?: string;
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export interface WatcherOptions {
  projectsDir: string;
  store: OfficeStore;
  config: ConfigSource;
  now?: () => number;
  intervalMs?: number;
}

export class TranscriptWatcher {
  /** Its id as an observe source (see sources.ts). */
  readonly id = 'claude-code';
  private files = new Map<string, FileState>();
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly opts: Required<Omit<WatcherOptions, 'intervalMs'>> & { intervalMs: number };

  constructor(options: WatcherOptions) {
    this.opts = { now: Date.now, intervalMs: SCAN_INTERVAL_MS, ...options };
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      void this.scanOnce().finally(() => {
        this.timer = setTimeout(tick, this.opts.intervalMs);
      });
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One polling round. Errors on one file never stop the others. */
  async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const startup = !this.started;
      this.started = true;
      const now = this.opts.now();
      const config = this.opts.config.get();
      const { files: found, unreadable } = await this.listTranscripts();
      const seen = new Set<string>();

      for (const file of found) {
        seen.add(file);
        try {
          await this.readFile(file, startup, now, config);
        } catch {
          // Locked or vanished mid-read: try again next round.
        }
      }
      for (const [file, state] of this.files) {
        // A folder that could not be listed this round says nothing about its
        // files: keep them, or they would be re-read from scratch next round.
        if (!seen.has(file) && !unreadable(file)) {
          this.files.delete(file);
          this.opts.store.removeGroup(state.sessionId);
        }
      }
      this.opts.store.prune(now, config.timing.groupLeaveMs);
    } finally {
      this.scanning = false;
    }
  }

  /** The transcripts found, and a test for files whose folder could not be listed this round. */
  private async listTranscripts(): Promise<{ files: string[]; unreadable: (file: string) => boolean }> {
    const files: string[] = [];
    let projects;
    try {
      projects = await fsp.readdir(this.opts.projectsDir, { withFileTypes: true });
    } catch {
      return { files, unreadable: () => true };
    }
    const failed = new Set<string>();
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(this.opts.projectsDir, project.name);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        failed.add(dir);
        continue;
      }
      // First level only: sub-agent transcripts live in <session>/subagents/.
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name));
      }
    }
    return { files, unreadable: (file) => failed.has(path.dirname(file)) };
  }

  private async readFile(file: string, startup: boolean, now: number, config: OfficeConfig): Promise<void> {
    const leaveMs = config.timing.groupLeaveMs;
    const labelMax = config.groupLabelMaxChars;
    const stat = await fsp.stat(file);
    let state = this.files.get(file);
    if (!state) {
      const sessionId = path.basename(file, '.jsonl');
      const recent = now - stat.mtimeMs < leaveMs;
      // At start-up an old transcript only counts from its current end; a recent
      // one rebuilds its state from the tail. A file first seen later is new: read it all.
      const offset = !startup ? 0 : recent ? Math.max(0, stat.size - STARTUP_TAIL_BYTES) : stat.size;
      state = {
        sessionId,
        offset,
        partial: Buffer.alloc(0),
        dropFirstLine: offset > 0 && offset < stat.size,
        toolNames: new Map(),
        lastCwd: '',
        labelTriedAt: -Infinity,
        homeKnown: false,
      };
      this.files.set(file, state);
      // Until the head is read, the project folder name decides the building.
      this.opts.store.setHome(sessionId, { projectDir: path.basename(path.dirname(file)) });
    }
    if (stat.size < state.offset) {
      // Rewritten from scratch: start over.
      state.offset = 0;
      state.partial = Buffer.alloc(0);
      state.dropFirstLine = false;
    }
    if (stat.size > state.offset) {
      // The start cwd goes in before any event, so no view ever shows the
      // session on a building decided by a later cwd.
      if (!state.homeKnown) {
        const cwd = firstCwd(await readHeadLines(file));
        if (cwd) {
          state.homeKnown = true;
          this.opts.store.setHome(state.sessionId, { cwd });
        }
      }
      await this.readNewBytes(file, state, stat.size, now);
    }

    const group = this.opts.store.groups.get(state.sessionId);
    if (!group) return;
    const known = state.streamTitle ?? state.headTitle ?? state.firstMessage;
    if (known === undefined && now - state.labelTriedAt >= LABEL_RETRY_MS) {
      state.labelTriedAt = now;
      const head = await readHeadLines(file);
      state.headTitle = latestTitle(head);
      state.firstMessage = firstUserMessage(head);
    }
    // A title beats the first message; the newest title beats an older one.
    const text = state.streamTitle ?? state.headTitle ?? state.firstMessage;
    if (text !== undefined) this.opts.store.setLabel(state.sessionId, shortenLabel(text, labelMax));
    await this.updateProgress(state, now, config);
  }

  /**
   * Re-reads the tasks.md of the session's current change when it moved, and
   * reports the ratio as a progress event. Masked buildings never get here past
   * the building check: their project files are never read.
   */
  private async updateProgress(state: FileState, now: number, config: OfficeConfig): Promise<void> {
    if (!state.change) return;
    const home = this.opts.store.homes.get(state.sessionId);
    if (buildingForSession(home, state.lastCwd, config).mask) return;
    const file = tasksPath(state.change, home?.cwd ?? state.lastCwd);
    const read = await readProgress(file, state.progressStamp);
    if (!read) return;
    state.progressStamp = read.stamp;
    this.opts.store.apply({
      kind: 'progress',
      source: 'observe',
      sessionId: state.sessionId,
      actorId: mainActorId(state.sessionId),
      cwd: state.lastCwd,
      at: now,
      ...(read.progress ? { progress: read.progress } : {}),
    });
  }

  private async readNewBytes(file: string, state: FileState, size: number, now: number): Promise<void> {
    const handle = await fsp.open(file, 'r');
    try {
      while (state.offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - state.offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        let data = state.partial.length > 0 ? Buffer.concat([state.partial, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        if (state.dropFirstLine) {
          const first = data.indexOf(NEWLINE);
          if (first === -1) {
            state.partial = Buffer.from(data);
            continue;
          }
          data = data.subarray(first + 1);
          state.dropFirstLine = false;
        }
        const last = data.lastIndexOf(NEWLINE);
        if (last === -1) {
          state.partial = Buffer.from(data);
          continue;
        }
        state.partial = Buffer.from(data.subarray(last + 1));
        for (const line of data.subarray(0, last).toString('utf-8').split('\n')) {
          this.handleLine(line, state, now);
        }
      }
    } finally {
      await handle.close();
    }
  }

  private handleLine(line: string, state: FileState, now: number): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseLine(trimmed, state.sessionId, state.toolNames, now, state.lastCwd);
    if (!parsed) return;
    if (parsed.cwd) state.lastCwd = parsed.cwd;
    if (parsed.title) state.streamTitle = parsed.title;
    if (parsed.change) {
      // A hint without a folder for the same change keeps the folder learned earlier.
      const sameChange = parsed.change.name === state.change?.name;
      const next = sameChange && !parsed.change.dir ? state.change! : parsed.change;
      if (next !== state.change && (next.name !== state.change?.name || next.dir !== state.change?.dir)) {
        state.change = next;
        state.progressStamp = undefined;
      }
    }
    this.opts.store.touch(state.sessionId, parsed.cwd ?? (state.lastCwd || undefined), parsed.at);
    for (const event of parsed.events) {
      if (event.cwd) this.opts.store.apply(event);
    }
  }
}

/** The first cwd recorded among the lines: where the session was started. */
export function firstCwd(lines: string[]): string | undefined {
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as { cwd?: unknown };
      if (typeof record.cwd === 'string' && record.cwd.length > 0) return record.cwd;
    } catch {
      // A broken line: keep looking.
    }
  }
  return undefined;
}

/** Complete lines from the head of a transcript (at most LABEL_HEAD_LINES); [] when unreadable. */
async function readHeadLines(file: string): Promise<string[]> {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf-8');
    const lines = text.split('\n');
    // The last piece may be cut mid-line unless the whole file fit.
    if (bytesRead === buffer.length) lines.pop();
    return lines.slice(0, LABEL_HEAD_LINES);
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}
