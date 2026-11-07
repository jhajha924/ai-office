import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../server/src/app.ts';
import { createConfigSource, DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { OfficeStore } from '../server/src/office/store.ts';
import { createSources } from '../server/src/observe/sources.ts';

describe('observe sources', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-sources-'));
    file = path.join(dir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The ids the server starts and the warnings it prints for a config file holding `observe`. */
  function run(observe: unknown): { ids: string[]; warnings: string[]; configWarnings: string[] } {
    const configWarnings: string[] = [];
    if (observe === undefined) fs.writeFileSync(file, '{}');
    else fs.writeFileSync(file, JSON.stringify({ observe: { sources: observe } }));
    const config = createConfigSource(file, { warn: (m) => configWarnings.push(m) });
    const warnings: string[] = [];
    const sources = createSources(
      config.get().observe.sources,
      { store: new OfficeStore(), config, now: Date.now, projectsDir: path.join(dir, 'projects') },
      (m) => warnings.push(m),
    );
    return { ids: sources.map((s) => s.id), warnings, configWarnings };
  }

  // office-transcript-observer spec, Example: 來源清單
  it('starts claude-code when observe is not set', () => {
    expect(run(undefined)).toEqual({ ids: ['claude-code'], warnings: [], configWarnings: [] });
    expect(DEFAULT_CONFIG.observe.sources).toEqual(['claude-code']);
  });

  it("starts claude-code for ['claude-code']", () => {
    expect(run(['claude-code'])).toEqual({ ids: ['claude-code'], warnings: [], configWarnings: [] });
  });

  // office-transcript-observer spec, Scenario: 設定了尚未支援的工具
  it("warns once about codex and still starts claude-code for ['claude-code', 'codex']", () => {
    const result = run(['claude-code', 'codex', 'codex']);
    expect(result.ids).toEqual(['claude-code']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('codex');
  });

  it('starts nothing and warns about nothing for []', () => {
    expect(run([])).toEqual({ ids: [], warnings: [], configWarnings: [] });
  });

  it("falls back to the whole defaults with a config warning for 'claude-code' given as a string", () => {
    const result = run('claude-code');
    expect(result.ids).toEqual(['claude-code']);
    expect(result.warnings).toEqual([]);
    expect(result.configWarnings).toHaveLength(1);
    expect(result.configWarnings[0]).toContain('observe.sources');
  });

  it('never resolves an id through the object prototype', () => {
    const warnings: string[] = [];
    const sources = createSources(['toString', '__proto__'], { store: new OfficeStore(), config: { get: () => DEFAULT_CONFIG }, now: Date.now, projectsDir: dir }, (m) => warnings.push(m));
    expect(sources).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  // office-transcript-observer spec, Scenario: 預設只觀察 Claude Code
  it('wires the sources into the app: started with the server, stopped with it, none in demo mode', async () => {
    const warn = vi.fn();
    const config = { get: () => ({ ...DEFAULT_CONFIG, observe: { sources: ['claude-code', 'codex'] } }) };
    const app = createApp({ port: 0, config, demo: false, projectsDir: path.join(dir, 'projects'), warn });
    expect(app.sources.map((s) => s.id)).toEqual(['claude-code']);
    expect(warn).toHaveBeenCalledTimes(1);
    const start = vi.spyOn(app.sources[0], 'start');
    const stop = vi.spyOn(app.sources[0], 'stop');
    await app.start();
    await app.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    const demo = createApp({ port: 0, config, demo: true, projectsDir: 'unused', warn });
    expect(demo.sources).toEqual([]);
  });
});
