import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createOpencodeAdapter} from '../server/ai/opencode';
import type {StartRun} from '../shared/contracts/ports';
import type {RunEvent} from '../shared/contracts/index';

// Explicit opt-in: real requests consume the user's already-configured opencode quota.
if (!process.argv.includes('--live')) {
  console.log('Use: npx tsx scripts/opencode-probe.ts --live [first|resume|summary|cancel]');
  process.exit(0);
}
const mode = process.argv.find(value => ['first', 'resume', 'summary', 'cancel'].includes(value)) || 'first';
const cwd = await mkdtemp(join(tmpdir(), 'momentread-opencode-probe-'));
const model = process.env.MOMENTREAD_TEST_MODEL;
const adapter = createOpencodeAdapter({cwd, maxRunMs: 120000, shutdownGraceMs: 5000, ...(model ? {model} : {})});
console.log(JSON.stringify({probe: await adapter.probe(), scenario: mode, ...(model ? {model} : {})}));
const bookId = randomUUID();
const make = (input: string, purpose: StartRun['purpose'] = 'discussion'): StartRun => ({runId: randomUUID(), bookId, discussionId: randomUUID(), purpose, contextSnapshotId: randomUUID(), input, session: {mode: 'new'}});
async function run(request: StartRun, options: {cancel?: boolean} = {}) {
  const handle = await adapter.start(request);
  const events: RunEvent[] = [];
  let cancelling = false;
  for await (const event of handle.events) {
    events.push(event);
    if (event.type !== 'text_delta') console.log(JSON.stringify(event));
    if (options.cancel && event.type === 'text_delta' && !cancelling) { cancelling = true; await adapter.cancel(request.runId); }
  }
  const terminal = events.at(-1);
  if (!terminal || !['completed', 'cancelled'].includes(terminal.type)) process.exitCode = 1;
  return events;
}
if (mode === 'first') {
  const events = await run(make('Reply with exactly: MOMENTREAD_OK'));
  assert.equal(events.at(-1)?.type, 'completed');
  assert.match(String(events.at(-1)?.data.text), /MOMENTREAD_OK/);
}
if (mode === 'resume') {
  const first = make('Remember this synthetic marker for this conversation: MREAD-OPENCODE-731. Reply OK only.');
  const firstEvents = await run(first);
  const id = firstEvents.find(event => event.type === 'initialized')?.data.cliSessionId;
  assert.equal(firstEvents.at(-1)?.type, 'completed');
  assert.equal(typeof id, 'string');
  const resumed = await run({...make('What marker did I ask you to remember? Reply with the marker only.'), discussionId: first.discussionId, session: {mode: 'resume', cliSessionId: id as string}});
  assert.equal(resumed.at(-1)?.type, 'completed');
  assert.match(String(resumed.at(-1)?.data.text), /MREAD-OPENCODE-731/);
}
if (mode === 'summary') {
  const schema = {type: 'object', properties: {content: {type: 'string'}}, required: ['content'], additionalProperties: false};
  const events = await run({...make('用一句话总结：今天学习了运行时隔离。', 'summary'), outputSchema: schema});
  assert.equal(events.at(-1)?.type, 'completed');
  const structured = events.at(-1)?.data.structuredOutput as {content?: string} | undefined;
  assert.equal(typeof structured?.content, 'string');
  assert.ok(structured!.content!.length > 0);
}
if (mode === 'cancel') {
  const cancelled = await run(make('写一篇不少于五百字的中文长文，详细介绍光合作用。'), {cancel: true});
  assert.equal(cancelled.at(-1)?.type, 'cancelled');
  const after = await run(make('Reply with exactly: MOMENTREAD_OK'));
  assert.equal(after.at(-1)?.type, 'completed');
  assert.match(String(after.at(-1)?.data.text), /MOMENTREAD_OK/);
}
