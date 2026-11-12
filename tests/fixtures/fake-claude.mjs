// A stand-in for `claude -p` in the dispatch tests. The prompt on stdin picks
// the behaviour: MODE:ok | MODE:exit1 | MODE:notjson | MODE:noschema | MODE:sleep.
// MODE:ok answers with the JSON after "OUTPUT:" as structured_output, and
// writes its argv and cwd to the file after "ARGS:" when given.
import * as fs from 'node:fs';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const mode = /MODE:(\w+)/.exec(input)?.[1] ?? 'ok';
  const argsFile = /ARGS:(\S+)/.exec(input)?.[1];
  if (argsFile) fs.writeFileSync(argsFile, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
  const usage = { input_tokens: 10, output_tokens: 20 };
  if (mode === 'exit1') process.exit(1);
  if (mode === 'notjson') return process.stdout.write('hello');
  if (mode === 'sleep') return setTimeout(() => undefined, 60_000);
  if (mode === 'noschema') {
    return process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'plain words', num_turns: 1, duration_ms: 5, usage }));
  }
  const output = JSON.parse(/OUTPUT:(\{.*\})/s.exec(input)?.[1] ?? '{"ok":true}');
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: output, num_turns: 2, duration_ms: 1234, total_cost_usd: 0.01, usage }),
  );
});
