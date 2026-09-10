import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createClaudeAdapter} from '../server/ai/index';
import type {StartRun} from '../shared/contracts/ports';
import type {RunEvent} from '../shared/contracts/index';

// Explicit opt-in: real requests consume the user's already-configured Claude quota.
if (!process.argv.includes('--live')) {
  console.log('Use: npx tsx scripts/claude-probe.ts --live [first|resume|isolation|cancel|summary|search|fetch|deny]');
  process.exit(0);
}
const mode = process.argv.find(value => ['first', 'resume', 'isolation', 'cancel', 'summary', 'search', 'fetch', 'deny'].includes(value)) || 'first';
const cwd = await mkdtemp(join(tmpdir(), 'momentread-cli-probe-'));
const adapter = createClaudeAdapter({cwd, maxRunMs: 120000, shutdownGraceMs: 5000});
console.log(JSON.stringify({probe: await adapter.probe(), scenario: mode}));
const bookId = randomUUID();
const make = (input: string, purpose: StartRun['purpose'] = 'discussion'): StartRun => ({runId: randomUUID(), bookId, discussionId: randomUUID(), purpose, contextSnapshotId: randomUUID(), input, session: {mode: 'new'}});
async function run(request: StartRun, options: {cancel?: boolean; deny?: boolean} = {}) {
  const handle = await adapter.start(request);
  const events: RunEvent[] = [];
  let cancelling = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  for await (const event of handle.events) {
    events.push(event);
    // Synthetic input/output only; never print auth status fields other than booleans.
    if (event.type !== 'text_delta') console.log(JSON.stringify(event));
    if (event.type === 'permission_required') await adapter.answerPermission(request.runId, String(event.data.requestId), options.deny ? 'deny' : 'allowOnce');
    if (options.cancel && event.type === 'initialized') cancelTimer = setTimeout(() => {if (!cancelling) {cancelling = true; void adapter.cancel(request.runId)}}, 4000);
    if (options.cancel && event.type === 'text_delta' && !cancelling) { cancelling = true; void adapter.cancel(request.runId); }
  }
  clearTimeout(cancelTimer);
  const terminal = events.at(-1);
  if (!terminal || !['completed', 'cancelled'].includes(terminal.type)) process.exitCode = 1;
  if (request.purpose === 'matching' && !options.deny) {
    const results = terminal?.data.toolResults as Array<{toolName: string; success: boolean; resultCount?: number}> | undefined;
    if (!results?.length || results.some(result => !result.success)) process.exitCode = 1;
    if (mode === 'search' && !results?.some(result => result.toolName === 'WebSearch' && result.success && (result.resultCount ?? 0) > 0)) {
      console.log(JSON.stringify({check: 'search_returned_result_links', passed: false, reason: 'No explicit result links were observed in the actual search tool response.'}));
      process.exitCode = 1;
    }
  }
  return events;
}
if (mode === 'first') {
  const events = await run(make('Reply with exactly: 中文流式测试成功'));
  assert.equal(events.at(-1)?.data.text, '中文流式测试成功');
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.data.text).join(''), '中文流式测试成功');
}
if (mode === 'resume') {
  const first = make('Remember this synthetic marker for this conversation: MREAD-CACTUS-731. Reply OK only.');
  const firstEvents = await run(first);
  const id = firstEvents.find(event => event.type === 'initialized')?.data.cliSessionId;
  assert.equal(firstEvents.at(-1)?.type, 'completed'); assert.equal(typeof id, 'string');
  const resumed = await run({...make('What marker did I ask you to remember? Reply with the marker only.'), discussionId: first.discussionId, session: {mode: 'resume', cliSessionId: id as string}});
  assert.equal(resumed.find(event => event.type === 'initialized')?.data.cliSessionId, id);
  assert.equal(resumed.at(-1)?.data.text, 'MREAD-CACTUS-731');
}
if (mode === 'isolation') {
  await run(make('Remember this private-to-this-discussion synthetic marker: MREAD-SIBLING-942. Reply OK only.'));
  const sibling = await run(make('What marker was provided earlier in this conversation? If none is present, reply exactly UNKNOWN. Do not guess.'));
  assert.equal(sibling.at(-1)?.data.text, 'UNKNOWN');
}
if (mode === 'cancel') {
  const cancelled = await run(make('Write a long fairy tale about a triangle learning what a side means. Start with the story immediately.'), {cancel: true});
  assert.equal(cancelled.at(-1)?.type, 'cancelled');
  assert.equal(cancelled.at(-1)?.data.sessionReusable, false);
  await run(make('Reply exactly: 取消后新运行成功'));
}
if (mode === 'summary') await run({...make('Summarize only this synthetic reading note in Chinese: A triangle has three sides. The term side means an edge here.', 'summary'), outputSchema: {type: 'object', properties: {summary: {type: 'string'}}, required: ['summary'], additionalProperties: false}});
if (mode === 'search') await run(make('Use WebSearch once to locate the official Project Gutenberg website. Then return its homepage URL and say whether the tool actually succeeded. Do not use WebFetch or claim to have read a book.', 'matching'));
if (mode === 'fetch' || mode === 'deny') await run(make('Use WebFetch exactly once for https://www.gutenberg.org/ and report whether its page title mentions Project Gutenberg. If permission is denied, stop and say DENIED; do not retry and do not use another tool.', 'matching'), {deny: mode === 'deny'});
