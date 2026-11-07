import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { withHook } from '../hook/install.ts';
import { ROOT_DIR } from '../server/src/app.ts';
import { createOfficeServer } from '../server/src/http/server.ts';
import { DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import type { OfficeEvent } from '../server/src/office/types.ts';
import { mainActorId, subActorId } from '../server/src/office/types.ts';
import { buildView } from '../server/src/office/view.ts';

/** Regressions found by the 2026-10-31 quality pass. */

const MIN = 60_000;
const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime();

function ev(kind: OfficeEvent['kind'], at: number, extra: Partial<OfficeEvent> = {}): OfficeEvent {
  return { kind, source: 'observe', sessionId: 's', actorId: mainActorId('s'), cwd: 'D:/home/x', at, ...extra };
}

describe('server survives malformed paths', () => {
  it('answers 400 to a NUL byte and keeps serving', async () => {
    const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-web-'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html>');
    const server = createOfficeServer({
      port: 0,
      getView: () => ({ floors: [], groups: [], feed: [], handoffs: [], generatedAt: 0 }),
      subscribe: () => () => {},
      onHook: () => {},
      webDir,
      assetsDir: path.join(ROOT_DIR, 'assets', 'kenney'),
    });
    const port = await server.listen();
    const get = (p: string) =>
      new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
    expect(await get('/%00')).toBe(400);
    expect(await get('/assets/kenney/%00.glb')).toBe(400);
    expect(await get('/api/state')).toBe(200);
    await server.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });
});

describe('main session state with helpers and parallel calls', () => {
  it('is not stuck while a sub-agent works for a long time', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Agent', toolUseId: 'a1' }));
    store.apply(ev('handoff.out', T0, { actorId: subActorId('s', 'a1'), subagentType: 'Explore', detail: '找資料' }));
    const actors = buildView(store, DEFAULT_CONFIG, T0 + 20 * MIN).groups[0].actors;
    expect(actors.map((a) => a.status)).toEqual(['running', 'running']);
  });

  it('can be stuck again once the sub-agent is back', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Agent', toolUseId: 'a1' }));
    store.apply(ev('handoff.out', T0, { actorId: subActorId('s', 'a1') }));
    store.apply(ev('handoff.back', T0 + MIN, { actorId: subActorId('s', 'a1'), toolUseId: 'a1' }));
    store.apply(ev('tool.end', T0 + MIN, { toolUseId: 'a1' }));
    expect(buildView(store, DEFAULT_CONFIG, T0 + MIN + 8 * MIN).groups[0].actors[0].status).toBe('stuck');
  });

  it('stays at work until the last of parallel tool calls returns', () => {
    const store = new OfficeStore();
    store.apply(ev('tool.start', T0, { tool: 'Read', toolUseId: 'r1', detail: 'D:/home/x/a.md' }));
    store.apply(ev('tool.start', T0, { tool: 'Grep', toolUseId: 'g1' }));
    store.apply(ev('tool.end', T0 + 1_000, { toolUseId: 'r1' }));
    let main = buildView(store, DEFAULT_CONFIG, T0 + 1_001).groups[0].actors[0];
    expect(main).toMatchObject({ status: 'running', tool: 'Grep' });
    store.apply(ev('tool.end', T0 + 2_000, { toolUseId: 'g1' }));
    main = buildView(store, DEFAULT_CONFIG, T0 + 2_001).groups[0].actors[0];
    expect(main.status).toBe('thinking');
  });
});

describe('hook install with a changed port', () => {
  it('updates the command of an installed entry instead of keeping the old port', () => {
    const installed = withHook({}, 'node "x/ai-office-hook.mjs" --port 5188');
    const moved = withHook(installed, 'node "x/ai-office-hook.mjs" --port 5190');
    expect(moved).not.toBe(installed);
    const groups = (moved.hooks as { Notification: { hooks: { command: string }[] }[] }).Notification;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toContain('--port 5190');
    expect(withHook(moved, 'node "x/ai-office-hook.mjs" --port 5190')).toBe(moved);
  });
});
