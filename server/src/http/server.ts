import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import type { PreviewResult } from '../office/outputPreview.ts';
import type { OfficeView } from '../office/types.ts';

/**
 * The local server: static page, GET /api/state, GET /events (SSE) and
 * POST /hook. It listens on 127.0.0.1 only and checks every Host header, so a
 * web page elsewhere cannot read the office through DNS rebinding. It sends no
 * CORS headers, never opens a browser and writes no log file.
 */

export const DEFAULT_PORT = 5188;
export const HOOK_HEADER = 'x-ai-office';
export const HOOK_HEADER_VALUE = 'hook';
export const MAX_BODY_BYTES = 64 * 1024;
/** Changes within this window go out as one `view` message. */
export const COALESCE_MS = 1_000;
export const HEARTBEAT_MS = 15_000;
/** How often time-based states (stuck, idle, leaving) are re-checked. */
export const RECHECK_MS = 5_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export interface OfficeServerOptions {
  port: number;
  getView: () => OfficeView;
  /** Called when the office state may have changed; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  onHook: (body: unknown) => void;
  /** GET /api/output/<token>; absent = the route answers 404. */
  getOutput?: (token: string) => Promise<PreviewResult>;
  webDir: string;
  assetsDir: string;
}

export interface OfficeServer {
  /** Resolves with the bound port; rejects with the listen error (e.g. EADDRINUSE). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** The view without its timestamp, to tell whether anything visible changed. */
function viewKey(view: OfficeView): string {
  return JSON.stringify({ buildings: view.buildings, groups: view.groups });
}

export function createOfficeServer(options: OfficeServerOptions): OfficeServer {
  let port = options.port;
  const clients = new Set<http.ServerResponse>();
  let pending: NodeJS.Timeout | undefined;
  let lastKey = '';
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | undefined;

  const send = (res: http.ServerResponse, event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const flush = (): void => {
    pending = undefined;
    const view = options.getView();
    const key = viewKey(view);
    if (key === lastKey) return;
    lastKey = key;
    for (const res of clients) send(res, 'view', view);
  };

  const schedule = (): void => {
    if (!pending) pending = setTimeout(flush, COALESCE_MS);
  };

  const hostAllowed = (host: string | undefined): boolean =>
    host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  function reply(res: http.ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function serveFile(res: http.ServerResponse, root: string, relative: string): void {
    const rootResolved = path.resolve(root);
    const target = path.resolve(rootResolved, `.${relative}`);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return reply(res, 403, '禁止存取');
    fs.readFile(target, (err, data) => {
      if (err) return reply(res, 404, '找不到');
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  function handleHook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers[HOOK_HEADER] !== HOOK_HEADER_VALUE) return reply(res, 403, '禁止存取');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reply(res, 413, '內容太大');
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        reply(res, 413, '內容太大');
        req.destroy();
        return;
      }
      if (!aborted) chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        options.onHook(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        // A malformed body is ignored; the hook script never waits for an answer.
      }
      reply(res, 204);
    });
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    const view = options.getView();
    send(res, 'snapshot', view);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function route(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!hostAllowed(req.headers.host)) return reply(res, 403, '禁止存取');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return reply(res, 400, '網址格式錯誤');
    }
    // A NUL byte makes fs throw synchronously; refuse it before any file access.
    if (pathname.includes('\0')) return reply(res, 400, '網址格式錯誤');

    if (req.method === 'POST' && pathname === '/hook') return handleHook(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, '不支援的方法');
    if (pathname === '/events') return handleEvents(req, res);
    const output = /^\/api\/output\/([0-9a-f]{16})$/.exec(pathname);
    if (output || pathname.startsWith('/api/output/')) {
      if (!output || !options.getOutput) return reply(res, 404, '找不到');
      void options.getOutput(output[1]).then(
        (result) =>
          result.status === 200
            ? reply(res, 200, JSON.stringify(result.body), 'application/json; charset=utf-8')
            : reply(res, result.status, result.status === 403 ? '此樓層不提供預覽' : '找不到'),
        () => reply(res, 500, '伺服器內部錯誤'),
      );
      return;
    }
    if (pathname === '/api/state') {
      return reply(res, 200, JSON.stringify(options.getView()), 'application/json; charset=utf-8');
    }
    if (pathname.startsWith('/assets/kenney/')) {
      return serveFile(res, options.assetsDir, pathname.slice('/assets/kenney'.length));
    }
    if (!fs.existsSync(path.join(options.webDir, 'index.html'))) {
      return reply(res, 503, '前端還沒建置，請先執行 npm run build');
    }
    return serveFile(res, options.webDir, pathname === '/' ? '/index.html' : pathname);
  }

  const server = http.createServer((req, res) => {
    // No request, however malformed, may take the whole office down.
    try {
      route(req, res);
    } catch {
      if (!res.headersSent) reply(res, 500, '伺服器內部錯誤');
      else res.destroy();
    }
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => {
          server.off('error', reject);
          port = (server.address() as AddressInfo).port;
          lastKey = viewKey(options.getView());
          unsubscribe = options.subscribe(schedule);
          timers.push(setInterval(schedule, RECHECK_MS));
          timers.push(
            setInterval(() => {
              for (const res of clients) res.write(': ping\n\n');
            }, HEARTBEAT_MS),
          );
          resolve(port);
        });
      });
    },
    close() {
      unsubscribe?.();
      for (const t of timers) clearInterval(t);
      if (pending) clearTimeout(pending);
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
