// ai-office-hook: forwards a Claude Code Notification event to the local AI
// office so it can show "等你核准". Whatever happens it gives up within one
// second, prints nothing and exits 0, so a Claude Code session never waits on
// it or sees an error — even when the office is not running.

const quit = () => process.exit(0);
setTimeout(quit, 1000);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

const MAX_BODY_BYTES = 60 * 1024;
const i = process.argv.indexOf('--port');
const port = (i > 0 && Number(process.argv[i + 1])) || 5188;

const chunks = [];
let size = 0;
process.stdin.on('data', (chunk) => {
  size += chunk.length;
  if (size <= MAX_BODY_BYTES) chunks.push(chunk);
});
process.stdin.on('error', quit);
process.stdin.on('end', async () => {
  if (size > MAX_BODY_BYTES) quit();
  try {
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Office': 'hook' },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(800),
    });
  } catch {
    // The office is not running or did not answer in time: nothing to do.
  }
  quit();
});
