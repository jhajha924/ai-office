import { createApp } from './app.ts';
import { DEFAULT_PORT } from './http/server.ts';
import { createConfigSource } from './office/config.ts';
import { defaultProjectsDir } from './observe/transcriptWatcher.ts';

/**
 * npm start            → watch ~/.claude/projects
 * npm run demo         → demo script, ~/.claude untouched
 * --projects-dir <dir> → watch another folder instead (tests, fixtures)
 */

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = createConfigSource();
const demo = process.argv.includes('--demo');
const envPort = process.env.AI_OFFICE_PORT ? Number(process.env.AI_OFFICE_PORT) : undefined;
const port = envPort ?? config.get().port ?? DEFAULT_PORT;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[AI 辦公室] 連接埠設定不正確：${process.env.AI_OFFICE_PORT}`);
  process.exit(1);
}

const app = createApp({
  port,
  config,
  demo,
  projectsDir: argValue('--projects-dir') ?? defaultProjectsDir(),
});

try {
  const bound = await app.start();
  console.log(`AI 辦公室${demo ? '（示範模式）' : ''}：http://127.0.0.1:${bound}/`);
  console.log('按 Ctrl+C 結束。');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`[AI 辦公室] 連接埠 ${port} 已被其他程式使用。請關掉那個程式，或設定環境變數 AI_OFFICE_PORT 換一個連接埠。`);
  } else {
    console.error(`[AI 辦公室] 無法啟動：${(err as Error).message}`);
  }
  process.exit(1);
}

const shutdown = (): void => {
  void app.stop().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
