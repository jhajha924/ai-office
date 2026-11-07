import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROOT_DIR } from '../server/src/app.ts';
import { HOOK_MARKER, run } from '../hook/install.ts';

const HOOK_SCRIPT = path.join(ROOT_DIR, 'hook', 'ai-office-hook.mjs');

describe('hook install / uninstall', () => {
  let dir: string;
  let file: string;
  let lines: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-hook-'));
    file = path.join(dir, 'settings.json');
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const go = (action: 'install' | 'uninstall', yes: boolean) =>
    run({ action, yes, settingsFile: file, port: 5188, log: (l) => lines.push(l) });

  const existing = {
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] },
  };

  // office-transcript-observer spec, Scenario: 預覽不寫入
  it('only previews without --yes', () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    const before = { text: fs.readFileSync(file, 'utf-8'), mtime: fs.statSync(file).mtimeMs };
    expect(go('install', false)).toBe(0);
    expect(lines.join('\n')).toContain(HOOK_MARKER);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before.text);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
    expect(fs.existsSync(`${file}.ai-office.bak`)).toBe(false);
  });

  // office-transcript-observer spec, Scenario: 保留既有 Hook
  it('keeps every other hook and restores the original after uninstall', () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    expect(go('install', true)).toBe(0);
    const installed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(installed.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(installed.hooks.Notification[0].hooks[0].command).toContain(HOOK_MARKER);
    expect(JSON.parse(fs.readFileSync(`${file}.ai-office.bak`, 'utf-8'))).toEqual(existing);

    expect(go('install', true)).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).hooks.Notification).toHaveLength(1);

    expect(go('uninstall', true)).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(existing);
  });

  it('leaves a settings file without hooks the way it was', () => {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }));
    go('install', true);
    go('uninstall', true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ model: 'opus' });
  });

  it('refuses to touch a settings file it cannot parse', () => {
    fs.writeFileSync(file, '{ broken');
    expect(go('install', true)).toBe(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ broken');
  });
});

function runHook(port: number, input: string): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK_SCRIPT, '--port', String(port)]);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

describe('hook script', () => {
  // office-transcript-observer spec, Scenario: 伺服器沒開
  it('exits 0 silently and quickly when the office is not running', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const result = await runHook(port, JSON.stringify({ session_id: 's', cwd: 'D:/x' }));
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.ms).toBeLessThan(1_500);
  });

  it('gives up within a second when the office does not answer', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const result = await runHook(port, '{}');
    silent.close();
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.ms).toBeLessThan(1_500);
  });

  it('forwards the notification with the office header', async () => {
    let received: { header?: string; body: string } | undefined;
    const office = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received = { header: req.headers['x-ai-office'] as string, body };
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => office.listen(0, '127.0.0.1', () => r()));
    const port = (office.address() as net.AddressInfo).port;
    const payload = JSON.stringify({ session_id: 's', cwd: 'D:/x', notification_type: 'permission_prompt' });
    const result = await runHook(port, payload);
    office.close();
    expect(result.code).toBe(0);
    expect(received).toEqual({ header: 'hook', body: payload });
  });
});
