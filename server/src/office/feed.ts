import { createHash } from 'node:crypto';

import type { OfficeConfig } from './config.ts';
import { buildingForSession } from './floorRouting.ts';
import { placeholderLabel } from './groupLabel.ts';
import { subagentTitle } from './roster.ts';
import { clip } from './statusText.ts';
import type { FeedRecord, OfficeStore } from './store.ts';
import type { FeedEntryView, HandoffView } from './types.ts';
import { mainActorId } from './types.ts';

/**
 * The people side of the processing station: employee names, activity feed
 * text, hand-off arcs and output tokens. Like the rest of the station it masks
 * on the server, so a masked building's subtask descriptions never leave it.
 */

/** Feed entries in a view, newest first. */
export const FEED_SHOWN = 30;
/** How long a hand-off stays in the view for its arc. */
export const HANDOFF_WINDOW_MS = 15_000;
const DETAIL_MAX_CHARS = 40;

/**
 * FNV-1a with a murmur3 finalizer. FNV alone spreads one id evenly but leaves
 * ids sharing a prefix ("<session>:main", "<session>:sub:…") correlated, so a
 * group's members kept drawing the same few names.
 */
function hashId(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The roster name of an actor: fixed per actor id, so a restart never renames anyone. */
export function nameFor(actorId: string, config: OfficeConfig): string {
  const names = config.roster.names;
  return names[hashId(actorId) % names.length];
}

/** Opaque id of one output file of one session: what GET /api/output/<token> takes. */
export function outputToken(sessionId: string, path: string): string {
  return createHash('sha256').update(`${sessionId}\n${path}`).digest('hex').slice(0, 16);
}

/** The session and path behind a token, among the outputs the store still holds; undefined if none. */
export function resolveOutputToken(store: OfficeStore, token: string): { sessionId: string; path: string } | undefined {
  for (let i = store.outputs.length - 1; i >= 0; i--) {
    const { sessionId, path } = store.outputs[i];
    if (outputToken(sessionId, path) === token) return { sessionId, path };
  }
  return undefined;
}

function recordText(record: FeedRecord, store: OfficeStore, config: OfficeConfig): { building: string; text: string } {
  const { building, mask } = buildingForSession(store.homes.get(record.sessionId), record.cwd, config);
  const main = nameFor(mainActorId(record.sessionId), config);
  const label = store.groups.get(record.sessionId)?.label ?? record.label ?? placeholderLabel(record.sessionId);
  const sub = () => `${nameFor(record.actorId, config)}（${subagentTitle(record.subagentType, building, config)}）`;
  switch (record.kind) {
    case 'done':
      return { building, text: `${main} 完成：${label}` };
    case 'waiting':
      return { building, text: `${main} 等你：${label}` };
    case 'handoff': {
      const what = mask || !record.detail?.trim() ? '派出子任務' : clip(record.detail, DETAIL_MAX_CHARS);
      return { building, text: `${main} → ${sub()}：${what}` };
    }
    case 'return':
      return { building, text: `${sub()}→ ${main} 交回` };
  }
}

/** The latest feed entries, newest first, with their building and masked text. */
export function buildFeed(store: OfficeStore, config: OfficeConfig): FeedEntryView[] {
  return store.feed
    .slice(-FEED_SHOWN)
    .reverse()
    .map((record) => ({ id: `f${record.seq}`, at: record.at, kind: record.kind, ...recordText(record, store, config) }));
}

/** Hand-offs and returns of the last HANDOFF_WINDOW_MS, oldest first, for the arcs between cards. */
export function buildHandoffs(store: OfficeStore, config: OfficeConfig, now: number): HandoffView[] {
  const out: HandoffView[] = [];
  for (const record of store.feed) {
    if (record.kind !== 'handoff' && record.kind !== 'return') continue;
    if (record.at > now || now - record.at >= HANDOFF_WINDOW_MS) continue;
    const { building, text } = recordText(record, store, config);
    const main = mainActorId(record.sessionId);
    const [from, to] = record.kind === 'handoff' ? [main, record.actorId] : [record.actorId, main];
    out.push({ id: `f${record.seq}`, at: record.at, building, from, to, label: text });
  }
  return out;
}
