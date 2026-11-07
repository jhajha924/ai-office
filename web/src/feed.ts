import type { FeedEntryView } from '../../server/src/office/types.ts';

/** The activity feed under the sidebar columns: this floor only, newest first. */

export const FEED_ITEMS = 30;

export interface FeedItem {
  id: string;
  time: string;
  kind: FeedEntryView['kind'];
  text: string;
}

/** HH:MM in local time. */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The entries of one floor, newest first (the view's order), at most FEED_ITEMS. */
export function feedItems(feed: FeedEntryView[], floor: string): FeedItem[] {
  return feed
    .filter((f) => f.floor === floor)
    .slice(0, FEED_ITEMS)
    .map((f) => ({ id: f.id, time: clock(f.at), kind: f.kind, text: f.text }));
}

export function renderFeed(list: HTMLElement, feed: FeedEntryView[], floor: string): void {
  const items = feedItems(feed, floor).map((item) => {
    const li = document.createElement('li');
    li.className = `feed-item kind-${item.kind}`;
    const time = document.createElement('time');
    time.textContent = item.time;
    li.append(time, ` ${item.text}`);
    return li;
  });
  list.replaceChildren(...items);
  list.closest('.feed')?.classList.toggle('empty-feed', items.length === 0);
}
