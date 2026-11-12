import './style.css';

import type { OfficeView } from '../../server/src/office/types.ts';
import { ArcLayer } from './arcs.ts';
import { boardContent } from './board.ts';
import { CardStrip, openPreview } from './cards.ts';
import { DispatchPanel, viewAfterDispatch } from './dispatch.ts';
import { renderFeed } from './feed.ts';
import type { LevelChoice } from './levels.ts';
import { levelSummary, pickLevel, roomName } from './levels.ts';
import { hourFromQuery, phaseAt } from './scene/daylight.ts';
import { Office } from './scene/office.ts';
import { applyStaticText } from './text.ts';
import { pickBuilding, Ui } from './ui.ts';

/**
 * Wires the page: one SSE connection to /events, every snapshot or view goes
 * to the 3D office, the card strip, the feed, the hand-off arcs and the HTML
 * around them. One building is on screen at a time: all its floors, or one.
 * When the stream drops, a banner shows and the page reconnects every 3
 * seconds; the next snapshot replaces the whole state.
 */

const RECONNECT_MS = 3_000;
const PHASE_CHECK_MS = 60_000;
const BUILDING_KEY = 'ai-office.floor';
const LEVEL_KEY = (building: string) => `ai-office.level.${building}`;

applyStaticText(document);

const office = new Office(document.getElementById('office')!);
const arcs = new ArcLayer(document.getElementById('arcs') as unknown as SVGSVGElement);
const feedList = document.getElementById('feed')!;
let view: OfficeView | undefined;
/** The remembered building until the first view says which buildings exist. */
let building = read(BUILDING_KEY) ?? '';
let level: LevelChoice = 'all';

const dispatchPanel = new DispatchPanel(
  document.getElementById('dispatch-button') as HTMLButtonElement,
  document.getElementById('dispatch-drawer')!,
  (accepted, dispatchBuilding) => {
    const next = viewAfterDispatch({ building, level }, dispatchBuilding, accepted);
    if (next.building === building) return;
    building = next.building;
    level = next.level;
    save(BUILDING_KEY, building);
    save(LEVEL_KEY(building), String(level));
    show();
  },
);

const cards = new CardStrip(document.getElementById('cards')!, {
  onFocus: (sessionId) => focus(sessionId),
  onPreview: (token, name) => void openPreview(token, name),
});

const ui = new Ui({
  onBuilding(next) {
    building = next;
    save(BUILDING_KEY, next);
    level = savedLevel(next);
    show();
  },
  onLevel: chooseLevel,
  onGroup(sessionId) {
    const group = view?.groups.find((g) => g.sessionId === sessionId);
    if (group && group.level !== level) {
      level = group.level;
      save(LEVEL_KEY(building), String(level));
      show();
    }
    focus(sessionId);
  },
});

/** The whole building or one floor, from the floor buttons or a click on a slab. */
function chooseLevel(next: LevelChoice): void {
  level = next;
  save(LEVEL_KEY(building), String(next));
  show();
}
office.onPickLevel = chooseLevel;

/** Glide the camera to a group, on whatever floor it is. */
function focus(sessionId: string): void {
  const group = view?.groups.find((g) => g.sessionId === sessionId);
  if (group) office.focusGroup(building, group.level, sessionId, group.seat);
}

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice just is not remembered.
  }
}

/** What to show in a building: the floor last looked at there, else the whole building (see pickLevel). */
function savedLevel(name: string): LevelChoice {
  const levels = view?.buildings.find((b) => b.name === name)?.levels ?? [];
  const raw = read(LEVEL_KEY(name));
  const saved = raw === 'all' ? 'all' : raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return pickLevel(saved, levels);
}

/** Settle building and floor against the view, point the scene at them, and redraw. */
function show(): void {
  if (!view) return;
  const nextBuilding = pickBuilding(building, view.buildings.map((b) => b.name));
  if (nextBuilding !== building) {
    building = nextBuilding;
    level = savedLevel(building);
  }
  const levels = view.buildings.find((b) => b.name === building)?.levels ?? [];
  if (level !== 'all' && !levels.some((l) => l.level === level)) level = 'all';
  const kind = levels.find((l) => l.level === level)?.kind ?? 'lobby';
  const slabs = levels.map((l) => {
    const { label, alert } = levelSummary(view!, building, l.level);
    return { level: l.level, theme: l.theme, label, ...(alert ? { alert } : {}) };
  });
  office.setBoard(boardContent(view, building));
  office.setView(building, level, roomName(kind), slabs);
  ui.render(view, building, level, office.overflow(view, building));
  cards.render(view, building, level);
  renderFeed(feedList, view.feed, building);
  arcs.draw(view.handoffs, building, (id) => cards.cardOf(id));
  dispatchPanel.update(view.dispatch);
}

function apply(next: OfficeView): void {
  const first = !view;
  view = next;
  if (first) level = savedLevel(pickBuilding(building, next.buildings.map((b) => b.name)));
  office.update(next);
  show();
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

// Views that came in while the models loaded were drawn without seats: once the
// office has placed them (its own deferred updates run first), redraw the page.
void office.ready.then(() => setTimeout(show));
connect();
