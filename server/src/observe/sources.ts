import type { ConfigSource } from '../office/config.ts';
import type { OfficeStore } from '../office/store.ts';
import { TranscriptWatcher } from './transcriptWatcher.ts';

/**
 * Observe sources: one adapter per AI tool whose conversations the office
 * shows. An adapter knows where that tool keeps its transcripts, how to read
 * only what is new, and how to turn a line into OfficeEvents; the rest of the
 * server only starts and stops it.
 *
 * Adding a tool = writing an adapter that feeds the store with OfficeEvents
 * and registering a factory for it in SOURCE_FACTORIES under a new id; users
 * then list that id in observe.sources of their config file.
 */

export interface ObserveSource {
  readonly id: string;
  start(): void;
  stop(): void;
}

export interface SourceContext {
  store: OfficeStore;
  config: ConfigSource;
  now: () => number;
  /** Claude Code's transcript folder (the --projects-dir option overrides it). */
  projectsDir: string;
}

export const SOURCE_FACTORIES: Record<string, (ctx: SourceContext) => ObserveSource> = {
  'claude-code': (ctx) => new TranscriptWatcher({ projectsDir: ctx.projectsDir, store: ctx.store, config: ctx.config, now: ctx.now }),
};

/**
 * The sources for the given ids, in order. An unknown id gets one warning and
 * is skipped; an empty list observes nothing (the server still runs).
 */
export function createSources(ids: string[], ctx: SourceContext, warn: (message: string) => void): ObserveSource[] {
  const sources: ObserveSource[] = [];
  const warned = new Set<string>();
  for (const id of ids) {
    const factory = Object.hasOwn(SOURCE_FACTORIES, id) ? SOURCE_FACTORIES[id] : undefined;
    if (!factory) {
      if (!warned.has(id)) warn(`[AI 辦公室] 不認得的觀察來源「${id}」，已略過。目前支援：${Object.keys(SOURCE_FACTORIES).join('、')}`);
      warned.add(id);
      continue;
    }
    if (sources.some((s) => s.id === id)) continue;
    sources.push(factory(ctx));
  }
  return sources;
}
