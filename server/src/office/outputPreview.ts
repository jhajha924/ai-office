import * as fsp from 'node:fs/promises';

import type { OfficeConfig } from './config.ts';
import { resolveOutputToken } from './feed.ts';
import { floorForSession } from './floorRouting.ts';
import { baseName } from './statusText.ts';
import type { OfficeStore } from './store.ts';

/**
 * GET /api/output/<token>: the plain-text preview of one output file. Only a
 * token for a file the session wrote today resolves, only on an unmasked
 * floor, and at most PREVIEW_MAX_BYTES are read. A masked floor's files are
 * never opened.
 */

export const PREVIEW_MAX_BYTES = 256 * 1024;
/** A NUL byte in this much of the head marks the file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface PreviewBody {
  name: string;
  text: string;
  truncated: boolean;
  binary: boolean;
}

export type PreviewResult = { status: 200; body: PreviewBody } | { status: 403 | 404 };

/** Where preview text comes from: the file itself, or (demo mode) the script's own text. */
export type PreviewSource = (path: string) => Promise<string | undefined>;

export async function readPreviewFile(path: string): Promise<{ bytes: Buffer; size: number } | undefined> {
  let handle;
  try {
    handle = await fsp.open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const bytes = Buffer.alloc(Math.min(stat.size, PREVIEW_MAX_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, bytesRead), size: stat.size };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function previewOutput(
  store: OfficeStore,
  config: OfficeConfig,
  token: string,
  demoText?: PreviewSource,
): Promise<PreviewResult> {
  const found = resolveOutputToken(store, token);
  if (!found) return { status: 404 };
  const output = store.outputs.find((o) => o.sessionId === found.sessionId && o.path === found.path)!;
  if (floorForSession(store.homes.get(found.sessionId), output.cwd, config).mask) return { status: 403 };
  const name = baseName(found.path);

  if (demoText) {
    const text = await demoText(found.path);
    return text === undefined ? { status: 404 } : { status: 200, body: { name, text, truncated: false, binary: false } };
  }

  const file = await readPreviewFile(found.path);
  if (!file) return { status: 404 };
  if (file.bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { status: 200, body: { name, text: '', truncated: false, binary: true } };
  }
  return {
    status: 200,
    body: { name, text: file.bytes.toString('utf-8'), truncated: file.size > PREVIEW_MAX_BYTES, binary: false },
  };
}
