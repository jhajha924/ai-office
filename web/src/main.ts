import './style.css';

import type { OfficeView } from '../../server/src/office/types.ts';
import { ArcLayer } from './arcs.ts';
import { CardStrip, openPreview } from './cards.ts';
import { renderFeed } from './feed.ts';
import { hourFromQuery, phaseAt } from './scene/daylight.ts';
import { Office } from './scene/office.ts';
import { applyStaticText } from './text.ts';
import { pickFloor, Ui } from './ui.ts';

/**
 * Wires the page: one SSE connection to /events, every snapshot or view goes
 * to the 3D office, the card strip, the feed, the hand-off arcs and the HTML
 * around them. When the stream drops, a banner shows and the page reconnects
 * every 3 seconds; the next snapshot replaces the whole state.
 */

const RECONNECT_MS = 3_000;
const PHASE_CHECK_MS = 60_000;
const FLOOR_KEY = 'ai-office.floor';

applyStaticText(document);

const office = new Office(document.getElementById('office')!);
const arcs = new ArcLayer(document.getElementById('arcs') as unknown as SVGSVGElement);
const feedList = document.getElementById('feed')!;
let view: OfficeView | undefined;
/** The remembered floor until the first view says which floors exist. */
let floor = readFloor() ?? '';

const cards = new CardStrip(document.getElementById('cards')!, {
  onFocus: (sessionId) => office.focusGroup(floor, sessionId),
  onPreview: (token, name) => void openPreview(token, name),
});

const ui = new Ui({
  onFloor(next) {
    floor = next;
    saveFloor(next);
    office.setFloor(next);
    render();
  },
  onGroup(sessionId) {
    office.focusGroup(floor, sessionId);
  },
});

function readFloor(): string | undefined {
  try {
    return localStorage.getItem(FLOOR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveFloor(value: string): void {
  try {
    localStorage.setItem(FLOOR_KEY, value);
  } catch {
    // Storage unavailable: the tab just is not remembered.
  }
}

function render(): void {
  if (!view) return;
  const shown = pickFloor(floor, view.floors.map((f) => f.name));
  if (shown !== floor) {
    floor = shown;
    office.setFloor(floor);
  }
  ui.render(view, floor, office.overflow(view, floor));
  cards.render(view, floor);
  renderFeed(feedList, view.feed, floor);
  arcs.draw(view.handoffs, floor, (id) => cards.cardOf(id));
}

function apply(next: OfficeView): void {
  view = next;
  floor = pickFloor(floor, next.floors.map((f) => f.name));
  office.setFloor(floor);
  office.update(next);
  render();
}

function connect(): void {
  const source = new EventSource('/events');
  const onMessage = (e: MessageEvent<string>) => {
    ui.setOnline(true);
    apply(JSON.parse(e.data) as OfficeView);
  };
  source.addEventListener('snapshot', onMessage);
  source.addEventListener('view', onMessage);
  source.onerror = () => {
    source.close();
    ui.setOnline(false);
    setTimeout(connect, RECONNECT_MS);
  };
}

/** ?hour=0..23 pins the time of day (for screenshots); otherwise the local clock decides. */
const pinnedHour = hourFromQuery(location.search);
const updatePhase = () => office.setPhase(phaseAt(pinnedHour ?? new Date().getHours()));
updatePhase();
setInterval(updatePhase, PHASE_CHECK_MS);

office.setFloor(floor);
connect();
