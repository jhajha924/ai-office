import { describe, expect, it } from 'vitest';

import type { LookupEnv } from '../server/src/dispatch/cli.ts';
import { checkAvailability, findClaude, findSpeclink } from '../server/src/dispatch/cli.ts';
import { parseConfig } from '../server/src/office/config.ts';

/** A fake Windows PATH whose files exist only in `files`. */
function winEnv(dirs: string[], files: string[]): LookupEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return { pathEnv: dirs.join(';'), platform: 'win32', isFile: (f) => set.has(f.toLowerCase()) };
}

const SETTINGS = { building: '私人樓', workRoot: 'D:\\work\\', models: { president: 'opus', manager: 'sonnet' } };
const NPM = 'C:\\npm';
const SHIM_EXE = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

describe('找出 claude 執行檔', () => {
  it('claudePath 有給就用它', () => {
    expect(findClaude('D:\\tools\\claude.exe', winEnv([NPM], ['D:\\tools\\claude.exe', SHIM_EXE]))).toBe('D:\\tools\\claude.exe');
  });

  it('PATH 上的 claude.exe 優先於 npm 的 claude.cmd', () => {
    const env = winEnv(['C:\\bin', NPM], ['C:\\bin\\claude.exe', 'C:\\npm\\claude.cmd', SHIM_EXE]);
    expect(findClaude(undefined, env)).toBe('C:\\bin\\claude.exe');
  });

  it('只有 claude.cmd 時取它同資料夾 node_modules 裡的 claude.exe，不執行 .cmd', () => {
    expect(findClaude(undefined, winEnv([NPM], ['C:\\npm\\claude.cmd', SHIM_EXE]))).toBe(SHIM_EXE);
  });

  it('claude.cmd 旁邊沒有 claude.exe → 找不到', () => {
    expect(findClaude(undefined, winEnv([NPM], ['C:\\npm\\claude.cmd']))).toBeUndefined();
  });

  it('speclink 找 PATH 上的 speclink.exe', () => {
    expect(findSpeclink(winEnv(['C:\\sl'], ['C:\\sl\\speclink.exe']))).toBe('C:\\sl\\speclink.exe');
  });

  it('其他平台找沒有副檔名的 claude', () => {
    const env: LookupEnv = { pathEnv: '/usr/bin:/opt/bin', platform: 'linux', isFile: (f) => f === '/opt/bin/claude' };
    expect(findClaude(undefined, env)).toBe('/opt/bin/claude');
  });
});

describe('可用性 (spec Example)', () => {
  const both = winEnv(['C:\\bin'], ['C:\\bin\\claude.exe', 'C:\\bin\\speclink.exe']);
  const ok = async () => true;

  it('沒有 dispatch → off', async () => {
    expect((await checkAvailability(undefined, both, ok)).status).toBe('off');
  });

  it.each([
    ['找得到且 --version 結束碼 0', '找得到且結束碼 0', both, ok, 'ready'],
    ['找不到', '找得到', winEnv(['C:\\bin'], ['C:\\bin\\speclink.exe']), ok, 'missing-claude'],
    ['找得到', '找不到', winEnv(['C:\\bin'], ['C:\\bin\\claude.exe']), ok, 'missing-speclink'],
    ['--version 逾時', '找得到', both, async (f: string) => !f.endsWith('claude.exe'), 'missing-claude'],
  ] as const)('claude %s、speclink %s → %s', async (_c, _s, env, check, status) => {
    expect((await checkAvailability(SETTINGS, env, check)).status).toBe(status);
  });
});

/** Two buildings like the example config: a masked work building and the unmasked default. */
const BUILDINGS = {
  rules: [{ prefix: 'C:\\Projects\\work\\', building: '工作樓', mask: true }],
  default: { building: '私人樓', mask: false },
};

const withDispatch = (dispatch: unknown) =>
  parseConfig(dispatch === undefined ? { buildings: BUILDINGS } : { buildings: BUILDINGS, dispatch });

describe('dispatch 設定驗證 (spec Example)', () => {
  it('沒有 dispatch → 派工 off', () => {
    expect(withDispatch(undefined).dispatch).toBeUndefined();
  });

  it('building 私人樓（未遮罩的預設棟）、workRoot D:\\work\\ → 派工設定有效', () => {
    expect(withDispatch({ building: '私人樓', workRoot: 'D:\\work\\' }).dispatch).toEqual({
      building: '私人樓',
      workRoot: 'D:\\work\\',
      models: { president: 'opus', manager: 'sonnet' },
    });
  });

  it.each([
    ['building 工作樓（遮罩棟）', { building: '工作樓', workRoot: 'D:\\work\\' }, 'dispatch.building'],
    ['building 不存在的棟', { building: '倉庫', workRoot: 'D:\\work\\' }, 'dispatch.building'],
    ['workRoot 空字串', { building: '私人樓', workRoot: '' }, 'dispatch.workRoot'],
    ['models.president 為數字', { building: '私人樓', workRoot: 'D:\\work\\', models: { president: 5 } }, 'dispatch.models.president'],
  ])('%s → ShapeError %s', (_label, dispatch, field) => {
    expect(() => withDispatch(dispatch)).toThrow(field);
  });

  it('models 只給一個時另一個用預設，claudePath 照收', () => {
    const d = withDispatch({ building: '私人樓', workRoot: 'D:\\work\\', models: { manager: 'opus' }, claudePath: 'C:\\x\\claude.exe' }).dispatch;
    expect(d?.models).toEqual({ president: 'opus', manager: 'opus' });
    expect(d?.claudePath).toBe('C:\\x\\claude.exe');
  });

  it('dispatch 不是物件 → ShapeError dispatch', () => {
    expect(() => withDispatch('yes')).toThrow('dispatch');
  });
});

describe('runVersion（不經殼層）', () => {
  it('結束碼 0 → true；不存在的執行檔 → false', async () => {
    const { runVersion } = await import('../server/src/dispatch/cli.ts');
    expect(await runVersion(process.execPath)).toBe(true);
    expect(await runVersion('Z:\no-such-dir\claude.exe')).toBe(false);
  });
});
