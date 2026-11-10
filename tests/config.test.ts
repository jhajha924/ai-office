import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigSource, DEFAULT_CONFIG } from '../server/src/office/config.ts';
import { buildingForCwd, buildingList } from '../server/src/office/floorRouting.ts';
import { skillTitle, subagentTitle } from '../server/src/office/roster.ts';

describe('config source', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-config-'));
    file = path.join(dir, '.ai-office', 'config.json');
    warn = vi.fn<(message: string) => void>();
    clock = 1_000_000;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const source = () => createConfigSource(file, { checkIntervalMs: 5_000, now: () => clock, warn });

  function write(text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf-8');
  }

  it('uses the built-in defaults silently when the file does not exist', () => {
    expect(source().get()).toEqual(DEFAULT_CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a valid file and fills missing keys from the defaults', () => {
    write(JSON.stringify({ roster: { subagents: { Explore: '情報員' } }, groupLabelMaxChars: 20 }));
    const config = source().get();
    expect(config.roster.subagents).toEqual({ Explore: '情報員' });
    expect(config.roster.skills).toEqual(DEFAULT_CONFIG.roster.skills);
    expect(config.buildings).toEqual(DEFAULT_CONFIG.buildings);
    expect(config.groupLabelMaxChars).toBe(20);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the defaults with one warning on non-JSON, without echoing the file', () => {
    write('{ "roster": secret-looking-text ');
    expect(source().get()).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('secret-looking-text');
  });

  it('falls back to the whole defaults when a field has the wrong type', () => {
    write(
      JSON.stringify({
        roster: { subagents: { Explore: '情報員' } },
        buildings: { rules: [{ prefix: 'D:\\work\\', building: '工作樓', mask: 'yes' }] },
      }),
    );
    expect(source().get()).toEqual(DEFAULT_CONFIG);
    expect(String(warn.mock.calls[0][0])).toContain('buildings.rules[0].mask');
  });

  // office-staff-roster spec, Scenario: 使用者改職稱
  it('applies an edited roster within 5 seconds without a restart', () => {
    const configSource = source();
    expect(subagentTitle('Explore', '私人樓', configSource.get())).toBe('資料調查員');
    write(JSON.stringify({ roster: { subagents: { Explore: '情報員' } } }));
    clock += 5_000;
    expect(subagentTitle('Explore', '私人樓', configSource.get())).toBe('情報員');
  });

  // office-building-routing spec, Scenario: 沒有設定檔／沒有設定檔時的預設樓層
  it('has one unmasked 辦公室 building and no folder rules when the file does not exist', () => {
    const config = source().get();
    expect(buildingList(config)).toEqual([{ building: '辦公室', mask: false }]);
    expect(config.buildings.rules).toEqual([]);
    expect(config.buildingOverrides).toEqual({});
    expect(buildingForCwd('C:\\Users\\User\\Downloads', config)).toEqual({ building: '辦公室', mask: false });
  });

  // office-building-routing spec, Scenario: 範例設定檔 / Example: 內建預設與範例設定
  it('parses config.example.json into a masked 工作樓 and a default 私人樓', () => {
    write(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.example.json'), 'utf-8'));
    const config = source().get();
    expect(warn).not.toHaveBeenCalled();
    expect(buildingList(config).map((f) => f.building)).toEqual(['工作樓', '私人樓']);
    expect(buildingForCwd('C:\\Projects\\work\\app', config)).toEqual({ building: '工作樓', mask: true });
    expect(buildingForCwd('D:\\notes', config)).toEqual({ building: '私人樓', mask: false });
  });

  // office-building-routing spec, Scenario: 新開一個個人專案
  it('routes a brand-new folder under a configured prefix without touching the config file', () => {
    const rules = { buildings: { rules: [{ prefix: 'D:\\home\\', building: '私人樓', mask: false }] } };
    write(JSON.stringify(rules));
    const before = fs.readFileSync(file, 'utf-8');
    const config = source().get();
    expect(buildingForCwd('D:\\home\\NewApp', config).building).toBe('私人樓');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  // office-floor-routing spec, Scenario: 只有舊鍵的設定檔
  it('reads the old keys floors / floor exactly like buildings / building, without a warning', () => {
    write(JSON.stringify({ floors: { rules: [{ prefix: 'D:\\work\\', floor: '工作樓', mask: true }], default: { floor: '私人樓', mask: false } } }));
    const old = source().get();
    write(JSON.stringify({ buildings: { rules: [{ prefix: 'D:\\work\\', building: '工作樓', mask: true }], default: { building: '私人樓', mask: false } } }));
    clock += 5_000;
    const now = createConfigSource(file, { checkIntervalMs: 5_000, now: () => clock, warn }).get();
    expect(old.buildings).toEqual(now.buildings);
    expect(old.buildings.rules).toEqual([{ prefix: 'D:\\work\\', building: '工作樓', mask: true }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses only the new keys when both are present', () => {
    write(
      JSON.stringify({
        buildings: { default: { building: '新棟', mask: false } },
        floors: { default: { floor: '舊棟', mask: true } },
        buildingOverrides: { 新棟: { skills: { x: '新' } } },
        floorOverrides: { 舊棟: { skills: { x: '舊' } } },
      }),
    );
    const config = source().get();
    expect(buildingList(config)).toEqual([{ building: '新棟', mask: false }]);
    expect(config.buildingOverrides).toEqual({ 新棟: { skills: { x: '新' } } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the old key in the warning when the old section is malformed', () => {
    write(JSON.stringify({ floors: { rules: [{ prefix: 'D:\\work\\', floor: '工作樓', mask: 'yes' }] } }));
    expect(source().get()).toEqual(DEFAULT_CONFIG);
    expect(String(warn.mock.calls[0][0])).toContain('floors.rules[0].mask');
  });

  // office-staff-roster spec, Scenario: 舊鍵 floorOverrides / 工作樓的開發工程師
  it('reads floorOverrides exactly like buildingOverrides', () => {
    const rules = { buildings: { rules: [{ prefix: 'D:\\work\\', building: '工作樓', mask: true }], default: { building: '私人樓', mask: false } } };
    write(JSON.stringify({ ...rules, floorOverrides: { 工作樓: { skills: { 'speclink-apply': '後端工程師' } } } }));
    const old = source().get();
    expect(skillTitle('speclink-apply', '工作樓', old)).toBe('後端工程師');
    expect(skillTitle('speclink-apply', '私人樓', old)).toBe('開發工程師');
    write(JSON.stringify({ ...rules, buildingOverrides: { 工作樓: { skills: { 'speclink-apply': '後端工程師' } } } }));
    clock += 5_000;
    const now = createConfigSource(file, { checkIntervalMs: 5_000, now: () => clock, warn }).get();
    expect(now.buildingOverrides).toEqual(old.buildingOverrides);
    expect(warn).not.toHaveBeenCalled();
  });
});
