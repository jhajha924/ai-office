import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from '../server/src/http/server.ts';
import { createConfigSource } from '../server/src/office/config.ts';

/**
 * npm run hook:install [-- --yes]   preview, or (with --yes) add the Notification hook
 * npm run hook:uninstall [-- --yes] preview, or (with --yes) remove it again
 *
 * Only the entries whose command contains HOOK_MARKER are ever added or
 * removed; every other setting and hook in ~/.claude/settings.json is kept as
 * it is. Before writing, the current file is copied to settings.json.ai-office.bak.
 */

export const HOOK_MARKER = 'ai-office-hook';
const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-office-hook.mjs');

type Json = Record<string, unknown>;
interface HookEntry {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: unknown;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isOurs = (entry: HookEntry): boolean => typeof entry.command === 'string' && entry.command.includes(HOOK_MARKER);

export function hookCommand(port: number): string {
  return `node "${HOOK_SCRIPT.replace(/\\/g, '/')}" --port ${port}`;
}

/**
 * Settings with our Notification hook added; unchanged (same object) when it
 * is already there with this command. An entry of ours with another command
 * (say, an older port) is updated in place.
 */
export function withHook(settings: Json, command: string): Json {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.Notification) ? (hooks.Notification as HookGroup[]) : [];
  const ours = groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks.filter(isOurs) : []));
  if (ours.length > 0) {
    if (ours.every((h) => h.command === command)) return settings;
    const updated = groups.map((g) =>
      Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.map((h) => (isOurs(h) ? { ...h, command } : h)) } : g,
    );
    return { ...settings, hooks: { ...hooks, Notification: updated } };
  }
  return {
    ...settings,
    hooks: { ...hooks, Notification: [...groups, { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }] },
  };
}

/** Settings with every entry carrying our marker removed, and the containers we emptied dropped. */
export function withoutHook(settings: Json): Json {
  if (!isObject(settings.hooks)) return settings;
  const hooks: Json = { ...settings.hooks };
  let touched = false;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const groups: HookGroup[] = [];
    for (const group of value as HookGroup[]) {
      if (!Array.isArray(group.hooks) || !group.hooks.some(isOurs)) {
        groups.push(group);
        continue;
      }
      touched = true;
      const rest = group.hooks.filter((h) => !isOurs(h));
      if (rest.length > 0) groups.push({ ...group, hooks: rest });
    }
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!touched) return settings;
  const out: Json = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function readSettings(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!isObject(parsed)) throw new Error('settings.json 不是 JSON 物件');
  return parsed;
}

export interface RunOptions {
  action: 'install' | 'uninstall';
  yes: boolean;
  settingsFile: string;
  port: number;
  log?: (line: string) => void;
}

/** Returns the process exit code. */
export function run(options: RunOptions): number {
  const log = options.log ?? ((line: string) => console.log(line));
  let settings: Json;
  try {
    settings = readSettings(options.settingsFile);
  } catch (err) {
    log(`[AI 辦公室] 讀不到 ${options.settingsFile}：${(err as Error).message}。沒有做任何修改。`);
    return 1;
  }
  const command = hookCommand(options.port);
  const next = options.action === 'install' ? withHook(settings, command) : withoutHook(settings);
  if (next === settings) {
    log(options.action === 'install' ? '[AI 辦公室] Hook 已經裝好了，不用再裝。' : '[AI 辦公室] 沒有找到 AI 辦公室的 Hook，不用移除。');
    return 0;
  }
  if (!options.yes) {
    log(options.action === 'install' ? `將在 ${options.settingsFile} 加入以下 Notification Hook：` : `將從 ${options.settingsFile} 移除這些 Hook：`);
    log(JSON.stringify({ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }, null, 2));
    log(`確認沒問題，再執行一次並加上 --yes（npm run hook:${options.action} -- --yes）。這次沒有寫入任何檔案。`);
    return 0;
  }
  if (fs.existsSync(options.settingsFile)) fs.copyFileSync(options.settingsFile, `${options.settingsFile}.ai-office.bak`);
  else fs.mkdirSync(path.dirname(options.settingsFile), { recursive: true });
  fs.writeFileSync(options.settingsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  log(
    options.action === 'install'
      ? `[AI 辦公室] 已加入 Hook，原檔備份在 ${options.settingsFile}.ai-office.bak。新開的 Claude Code 對話才會生效。`
      : `[AI 辦公室] 已移除 Hook，原檔備份在 ${options.settingsFile}.ai-office.bak。`,
  );
  return 0;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action !== 'install' && action !== 'uninstall') {
    console.log('用法：npm run hook:install 或 npm run hook:uninstall（加 -- --yes 才會寫入）');
    process.exit(1);
  }
  // The same port the server uses: AI_OFFICE_PORT, else config.json's port, else the default.
  // An empty AI_OFFICE_PORT counts as unset, as it does for the server.
  const raw = process.env.AI_OFFICE_PORT || (createConfigSource().get().port ?? DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.log(`[AI 辦公室] 連接埠設定不正確：${raw}。沒有做任何修改。`);
    process.exit(1);
  }
  process.exit(
    run({
      action,
      yes: process.argv.includes('--yes'),
      settingsFile: argValue('--settings') ?? path.join(os.homedir(), '.claude', 'settings.json'),
      port,
    }),
  );
}
