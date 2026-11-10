import type { HandoffView } from '../../server/src/office/types.ts';

/**
 * Hand-off arcs: when a sub-agent is sent out or comes back, an animated
 * curve runs from one card to the other above the card strip, labelled, and
 * fades after a few seconds. Each hand-off is drawn once.
 */

export const ARC_SHOW_MS = 4_000;
const DOT_TRAVEL_MS = 1_200;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Box {
  left: number;
  top: number;
  width: number;
}

export interface ArcGeometry {
  d: string;
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
  /** The curve's point at t = 0.5, where the label goes. */
  apex: { x: number; y: number };
}

/** A quadratic curve from the top middle of one card to the top middle of another, bowing upwards. */
export function arcPath(from: Box, to: Box): ArcGeometry {
  const start = { x: from.left + from.width / 2, y: from.top };
  const end = { x: to.left + to.width / 2, y: to.top };
  const lift = 60 + Math.abs(end.x - start.x) * 0.25;
  const control = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - lift };
  const apex = {
    x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
  };
  return { d: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, start, control, end, apex };
}

function pointAt(g: ArcGeometry, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * g.start.x + 2 * u * t * g.control.x + t * t * g.end.x,
    y: u * u * g.start.y + 2 * u * t * g.control.y + t * t * g.end.y,
  };
}

/**
 * The hand-offs to draw now: on this building, not drawn before, both cards on
 * screen (`boxOf` returns undefined otherwise). Marks them drawn, so each is
 * drawn once.
 */
export function newArcs(
  handoffs: HandoffView[],
  building: string,
  drawn: Set<string>,
  boxOf: (actorId: string) => Box | undefined,
): { id: string; geometry: ArcGeometry; label: string }[] {
  const out: { id: string; geometry: ArcGeometry; label: string }[] = [];
  for (const h of handoffs) {
    if (drawn.has(h.id) || h.building !== building) continue;
    const from = boxOf(h.from);
    const to = boxOf(h.to);
    if (!from || !to) continue;
    drawn.add(h.id);
    out.push({ id: h.id, geometry: arcPath(from, to), label: h.label });
  }
  return out;
}

export class ArcLayer {
  private readonly svg: SVGSVGElement;
  private readonly drawn = new Set<string>();

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
  }

  /** Draws the new hand-offs of this building whose two cards are on screen. */
  draw(handoffs: HandoffView[], building: string, cardOf: (actorId: string) => HTMLElement | undefined): void {
    const boxOf = (id: string): Box | undefined => {
      const card = cardOf(id);
      return card && onScreen(card) ? card.getBoundingClientRect() : undefined;
    };
    for (const arc of newArcs(handoffs, building, this.drawn, boxOf)) this.animate(arc.geometry, arc.label);
  }

  private animate(g: ArcGeometry, label: string): void {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'arc');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', g.d);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '6');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(g.apex.x));
    text.setAttribute('y', String(g.apex.y - 10));
    text.setAttribute('text-anchor', 'middle');
    text.textContent = label;
    group.append(path, dot, text);
    this.svg.append(group);

    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / DOT_TRAVEL_MS);
      const p = pointAt(g, t);
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => group.classList.add('fading'), ARC_SHOW_MS - 600);
    setTimeout(() => group.remove(), ARC_SHOW_MS);
  }
}

function onScreen(card: HTMLElement): boolean {
  const r = card.getBoundingClientRect();
  return r.width > 0 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
}
