import * as THREE from 'three';

import type { BoardContent } from '../board.ts';

/**
 * The lobby's war-room board as a picture: the three columns of
 * boardContent drawn on a canvas that the board on the back wall shows.
 * Every lobby (the one-floor view and the copies in the whole-building view)
 * shares this one texture, so it is redrawn once per change, and only when
 * what it says has changed.
 */

const WIDTH = 2560;
const HEIGHT = 620;
const COLUMN_COLORS = ['#f59e0b', '#ef4444', '#38bdf8'];

export class WarBoard {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private key = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw({ columns: [] });
  }

  draw(content: BoardContent): void {
    const key = JSON.stringify(content);
    if (key === this.key) return;
    this.key = key;
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const font = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
    const colW = WIDTH / 3;
    content.columns.forEach((col, i) => {
      const x = i * colW;
      if (i > 0) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(x - 3, 24, 6, HEIGHT - 48);
      }
      ctx.fillStyle = COLUMN_COLORS[i] ?? '#e2e8f0';
      ctx.fillRect(x + 28, 26, 16, 64);
      ctx.font = `bold 68px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(col.title, x + 60, 58);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = `56px ${font}`;
      col.items.forEach((item, k) => {
        ctx.fillText(fit(ctx, item, colW - 70), x + 40, 140 + k * 76);
      });
    });
    this.texture.needsUpdate = true;
  }
}

/** Cut a line to the width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}
