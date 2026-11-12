import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_CONFIG, DemoSource } from './demo/demoSource.ts';
import type { LookupEnv, VersionCheck } from './dispatch/cli.ts';
import { checkAvailability } from './dispatch/cli.ts';
import { DEMO_DISPATCH, DemoRunner } from './dispatch/demoRunner.ts';
import { DispatchEngine, realFs } from './dispatch/engine.ts';
import { defaultProjectsDir, fileStorage } from './dispatch/persist.ts';
import { ClaudeRunner } from './dispatch/runner.ts';
import type { AgentRunner } from './dispatch/types.ts';
import { panelView } from './dispatch/view.ts';
import type { OfficeServer } from './http/server.ts';
import { createOfficeServer } from './http/server.ts';
import type { ConfigSource } from './office/config.ts';
import { OfficeStore } from './office/store.ts';
import { mainActorId } from './office/types.ts';
import { previewOutput } from './office/outputPreview.ts';
import { buildView } from './office/view.ts';
import type { ObserveSource } from './observe/sources.ts';
import { createSources } from './observe/sources.ts';

/** The repository root (server/src/app.ts → ../..). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AppOptions {
  port: number;
  config: ConfigSource;
  /** Demo script instead of real transcripts; ~/.claude is never read. */
  demo: boolean;
  projectsDir: string;
  now?: () => number;
  webDir?: string;
  assetsDir?: string;
  /** Where start-up warnings go (an unknown observe source); the console by default. */
  warn?: (message: string) => void;
  /** Where dispatch records live; ~/.ai-office/projects by default. */
  dispatchDir?: string;
  /** Tests: the PATH lookup, the --version check and the runner used for dispatch. */
  lookup?: LookupEnv;
  versionCheck?: VersionCheck;
  runner?: AgentRunner;
}

export interface App {
  store: OfficeStore;
  server: OfficeServer;
  /** The observe sources from observe.sources; none in demo mode. */
  sources: ObserveSource[];
  demo?: DemoSource;
  /** Present once start() ran and dispatch is configured (or in demo mode). */
  dispatch?: DispatchEngine;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Only permission prompts mean "waiting for you"; the idle reminder Claude
 * Code sends a minute after a finished turn is not a request for approval.
 */
export function hookToEvent(body: unknown, now: number) {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const sessionId = typeof b.session_id === 'string' ? b.session_id : '';
  const cwd = typeof b.cwd === 'string' ? b.cwd : '';
  if (!sessionId || !cwd) return undefined;
  const type = typeof b.notification_type === 'string' ? b.notification_type : undefined;
  const message = typeof b.message === 'string' ? b.message : '';
  const permission = type === undefined ? /permission/i.test(message) : type === 'permission_prompt';
  if (!permission) return undefined;
  return { kind: 'waiting', source: 'hook', sessionId, actorId: mainActorId(sessionId), cwd, at: now } as const;
}

export function createApp(options: AppOptions): App {
  const now = options.now ?? Date.now;
  const store = new OfficeStore();
  // The demo always shows its own two buildings, whatever the user's config says.
  const config: ConfigSource = options.demo ? { get: () => DEMO_CONFIG } : options.config;
  // The list of sources is read once, at start-up.
  const sources = options.demo
    ? []
    : createSources(
        config.get().observe.sources,
        { store, config, now, projectsDir: options.projectsDir },
        options.warn ?? ((message) => console.warn(message)),
      );
  const demo = options.demo ? new DemoSource(store, now) : undefined;

  let dispatch: DispatchEngine | undefined;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  /** Manager offices taken by a manager still in the office. */
  const occupiedOffices = (): Set<number> => {
    const taken = new Set<number>();
    const leaveMs = config.get().timing.groupLeaveMs;
    for (const group of store.groups.values()) {
      if (group.seat?.kind === 'manager' && now() - group.lastActivity < leaveMs) taken.add(group.seat.office);
    }
    return taken;
  };

  async function startDispatch(): Promise<void> {
    if (options.demo) {
      dispatch = new DispatchEngine({
        settings: DEMO_DISPATCH,
        status: 'ready',
        departments: () => config.get().departments,
        runner: options.runner ?? new DemoRunner(),
        projectsDir: DEMO_DISPATCH.workRoot,
        emit: (event) => store.apply(event),
        setLabel: (sessionId, label) => store.setLabel(sessionId, label),
        occupiedOffices,
        now,
        // The demo's folders are made up: they "exist", and nothing is created.
        isDir: () => true,
      });
      return;
    }
    const settings = config.get().dispatch;
    if (!settings) return;
    const availability = await checkAvailability(settings, options.lookup, options.versionCheck);
    const projectsDir = options.dispatchDir ?? defaultProjectsDir();
    dispatch = new DispatchEngine({
      settings,
      status: availability.status,
      departments: () => config.get().departments,
      runner: options.runner ?? new ClaudeRunner({ file: availability.claude ?? 'claude' }),
      projectsDir,
      storage: fileStorage(projectsDir, warn),
      emit: (event) => store.apply(event),
      setLabel: (sessionId, label) => store.setLabel(sessionId, label),
      occupiedOffices,
      now,
      isDir: realFs.isDir,
      makeDir: realFs.makeDir,
    });
    if (availability.status !== 'ready') {
      warn(`[AI 辦公室] 派工已停用：${availability.status === 'missing-claude' ? '找不到 claude' : '找不到 speclink'}`);
    }
  }

  const dispatchPanel = () =>
    dispatch
      ? panelView(
          { status: dispatch.status, building: dispatch.settings.building, dispatches: dispatch.dispatches, active: () => dispatch!.active() },
          config.get().departments,
        )
      : undefined;

  const server = createOfficeServer({
    port: options.port,
    getView: () => buildView(store, config.get(), now(), dispatchPanel()),
    onDispatch: (body) =>
      dispatch ? dispatch.submit(body && typeof body === 'object' ? (body as Record<string, unknown>).text : undefined) : { ok: false, status: 404, message: '找不到' },
    onDecision: (id, body) => (dispatch ? dispatch.answer(id, body) : { ok: false, status: 404, message: '找不到' }),
    subscribe: (listener) => store.onChange(listener),
    // Demo mode previews come from the script's own text: no file is read.
    getOutput: (token) => previewOutput(store, config.get(), token, demo ? (p) => Promise.resolve(demo.previewText(p)) : undefined),
    onHook: (body) => {
      const event = hookToEvent(body, now());
      if (event && !options.demo) store.apply(event);
    },
    webDir: options.webDir ?? path.join(ROOT_DIR, 'web', 'dist'),
    assetsDir: options.assetsDir ?? path.join(ROOT_DIR, 'assets', 'kenney'),
  });

  return {
    store,
    server,
    sources,
    demo,
    get dispatch() {
      return dispatch;
    },
    async start() {
      await startDispatch();
      const port = await server.listen();
      for (const source of sources) source.start();
      demo?.start();
      return port;
    },
    async stop() {
      for (const source of sources) source.stop();
      demo?.stop();
      await server.close();
    },
  };
}
