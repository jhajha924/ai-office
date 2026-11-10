import type { ActorView, GroupView, OfficeView } from '../../server/src/office/types.ts';
import type { LevelChoice } from './levels.ts';
import { STATUS_TEXT, TEXT } from './text.ts';

/**
 * The card strip along the bottom: one card per employee on the building being
 * viewed. A card that leaves stays a few seconds in a fading state, so a
 * "交回" arc still has a card to start from.
 */

export { STATUS_TEXT };

const MODEL_LETTER: Record<ActorView['model'], string> = { opus: 'O', sonnet: 'S', haiku: 'H', fable: 'F', other: '' };
/** Output names a card shows before "+N". */
export const TAGS_SHOWN = 3;
/** How long a departed employee's card lingers. */
export const LEAVING_CARD_MS = 4_500;

export type CardProgress = { kind: 'ratio'; done: number; total: number; percent: number } | { kind: 'indeterminate' };

export interface CardModel {
  initial: string;
  modelLetter: string;
  name: string;
  title: string;
  statusText: string;
  task: string;
  progress?: CardProgress;
  /** Output tags shown (token + name), at most TAGS_SHOWN. */
  tags: { token: string; name: string }[];
  /** Outputs beyond the shown tags. */
  more: number;
  /** "N 個檔案" on a masked building, where no names are given. */
  countText?: string;
}

/** What a card shows for an actor; pure, so the strip and the tests agree. */
export function cardModel(actor: ActorView): CardModel {
  const progress: CardProgress | undefined =
    actor.progress === undefined
      ? undefined
      : actor.progress === 'indeterminate'
        ? { kind: 'indeterminate' }
        : { kind: 'ratio', ...actor.progress, percent: (actor.progress.done / actor.progress.total) * 100 };
  const outputs = actor.outputs ?? [];
  const masked = actor.outputs === undefined && (actor.outputCount ?? 0) > 0;
  return {
    initial: Array.from(actor.name)[0] ?? '?',
    modelLetter: MODEL_LETTER[actor.model],
    name: actor.name,
    title: actor.title,
    statusText: STATUS_TEXT[actor.status],
    task: actor.task,
    ...(progress ? { progress } : {}),
    tags: outputs.slice(0, TAGS_SHOWN),
    more: Math.max(0, (actor.outputCount ?? outputs.length) - Math.min(outputs.length, TAGS_SHOWN)),
    ...(masked ? { countText: TEXT.fileCount(actor.outputCount ?? 0) } : {}),
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface CardHandlers {
  onFocus(sessionId: string): void;
  onPreview(token: string, name: string): void;
}

export class CardStrip {
  private readonly root: HTMLElement;
  private readonly handlers: CardHandlers;
  /** Cards of employees that just left, with when they go away. */
  private leaving = new Map<string, { card: HTMLElement; until: number }>();
  private shown = new Map<string, HTMLElement>();
  /** Building and floor on screen, as one key. */
  private where?: string;

  constructor(root: HTMLElement, handlers: CardHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  /** The card element of an actor, departed ones included; for the arcs. */
  cardOf(actorId: string): HTMLElement | undefined {
    return this.shown.get(actorId) ?? this.leaving.get(actorId)?.card;
  }

  /** The cards of one building: all its floors, or one. */
  render(view: OfficeView, building: string, level: LevelChoice, now = Date.now()): void {
    const groups = view.groups.filter((g) => g.building === building && (level === 'all' || g.level === level));
    const next = new Map<string, HTMLElement>();
    for (const group of groups) for (const actor of group.actors) next.set(actor.id, this.card(actor, group));

    // Switching building or floor is not anyone leaving: the other floor's cards just go.
    const where = `${building}#${level}`;
    if (where !== this.where) {
      this.where = where;
      this.shown.clear();
      this.leaving.clear();
    }
    for (const [id, card] of this.shown) {
      if (!next.has(id) && !this.leaving.has(id)) {
        card.classList.add('leaving');
        this.leaving.set(id, { card, until: now + LEAVING_CARD_MS });
      }
    }
    for (const [id, { until }] of this.leaving) if (until <= now || next.has(id)) this.leaving.delete(id);

    this.shown = next;
    const scroll = this.root.scrollLeft;
    this.root.replaceChildren(...next.values(), ...[...this.leaving.values()].map((l) => l.card));
    this.root.scrollLeft = scroll;
    this.root.hidden = this.root.children.length === 0;
  }

  private card(actor: ActorView, group: GroupView): HTMLElement {
    const m = cardModel(actor);
    const card = el('article', `card status-${actor.status} role-${actor.role}`);
    card.dataset.actor = actor.id;
    card.title = `${m.name}（${m.title}）`;

    const head = el('div', 'card-head');
    const avatar = el('div', 'avatar', m.initial);
    if (m.modelLetter) avatar.append(el('span', `model model-${actor.model}`, m.modelLetter));
    const who = el('div', 'who');
    who.append(el('div', 'card-name', m.name), el('div', 'card-title', m.title));
    head.append(avatar, who, el('span', 'card-status', m.statusText));

    card.append(head, el('div', 'card-task', m.task));

    if (m.progress) {
      const bar = el('div', `progress ${m.progress.kind}`);
      const fill = el('div', 'fill');
      if (m.progress.kind === 'ratio') {
        fill.style.width = `${m.progress.percent}%`;
        bar.append(fill, el('span', 'ratio', `${m.progress.done}/${m.progress.total}`));
      } else {
        bar.append(fill);
      }
      card.append(bar);
    }

    if (m.tags.length > 0 || m.countText) {
      const tags = el('div', 'tags');
      for (const tag of m.tags) {
        const button = el('button', 'tag-file', tag.name);
        button.type = 'button';
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handlers.onPreview(tag.token, tag.name);
        });
        tags.append(button);
      }
      if (m.countText) tags.append(el('span', 'tag-count', m.countText));
      else if (m.more > 0) tags.append(el('span', 'tag-more', `+${m.more}`));
      card.append(tags);
    }

    card.addEventListener('click', () => this.handlers.onFocus(group.sessionId));
    return card;
  }
}

/** The preview dialog: plain text only, closed by Esc or a click outside. */
export async function openPreview(token: string, name: string): Promise<void> {
  const backdrop = el('div', 'preview-backdrop');
  const dialog = el('div', 'preview');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', TEXT.previewLabel(name));
  const title = el('div', 'preview-title', name);
  const body = el('pre', 'preview-body', TEXT.previewLoading);
  dialog.append(title, body);
  backdrop.append(dialog);
  document.body.append(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  try {
    const res = await fetch(`/api/output/${token}`);
    if (res.status === 403) {
      body.textContent = TEXT.previewRefused;
      return;
    }
    if (!res.ok) {
      body.textContent = TEXT.previewMissing;
      return;
    }
    const data = (await res.json()) as { text: string; truncated: boolean; binary: boolean };
    if (data.binary) {
      body.textContent = TEXT.previewBinary;
      return;
    }
    // textContent only: the file is never parsed as HTML.
    body.textContent = data.text;
    if (data.truncated) title.textContent = TEXT.previewTruncated(name);
  } catch {
    body.textContent = TEXT.previewFailed;
  }
}
