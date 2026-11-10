import type { GroupView, OfficeView } from '../../server/src/office/types.ts';
import { levelTag } from './levels.ts';
import { FEED_CATEGORY, TEXT } from './text.ts';

/**
 * What the war-room board on the lobby's back wall says: three columns for
 * the building on screen — groups waiting for your decision, groups that look
 * stuck, and the latest activity. Pure, from OfficeView only (masked
 * buildings are masked by the server already).
 */

/** At most this many lines per column. */
export const BOARD_ITEMS = 6;

export interface BoardColumn {
  /** 「待你決議 2」: the column's name and how many there are in all. */
  title: string;
  /** The lines, or 「（無）」 alone when there are none. */
  items: string[];
}

export interface BoardContent {
  /** Always three: 待你決議, 卡住, 最新動態. */
  columns: BoardColumn[];
}

const column = (title: string, lines: string[]): BoardColumn => ({
  title,
  items: lines.length > 0 ? lines.slice(0, BOARD_ITEMS) : [TEXT.boardNone],
});

export function boardContent(view: OfficeView, building: string): BoardContent {
  const groups = view.groups.filter((g) => g.building === building).sort((a, b) => b.lastActivity - a.lastActivity);
  const withMain = (status: 'waiting' | 'stuck') => groups.filter((g) => g.actors.find((a) => a.role === 'main')?.status === status);
  const line = (g: GroupView) => `${levelTag(g.level)} ${g.label}`;
  const decide = withMain('waiting');
  const stuck = withMain('stuck');
  const feed = view.feed.filter((f) => f.building === building).sort((a, b) => b.at - a.at);
  return {
    columns: [
      column(TEXT.boardDecide(decide.length), decide.map(line)),
      column(TEXT.boardStuck(stuck.length), stuck.map(line)),
      column(TEXT.boardFeed(Math.min(feed.length, BOARD_ITEMS)), feed.map((f) => `${FEED_CATEGORY[f.kind]} ${f.text}`)),
    ],
  };
}
