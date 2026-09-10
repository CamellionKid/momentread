import {describe, expect, it} from 'vitest';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonLineDecoder, TextAccumulator, redactDiagnostic, classifyCliFailure, webSearchResultCount} from '../../server/ai/protocol';
import {claudeArguments, createClaudeAdapter} from '../../server/ai/index';
import type {StartRun} from '../../shared/contracts/ports';
import type {RunEvent} from '../../shared/contracts/index';

const request = (purpose: StartRun['purpose'] = 'discussion'): StartRun => ({runId: randomUUID(), bookId: randomUUID(), discussionId: randomUUID(), purpose, contextSnapshotId: randomUUID(), input: '合成测试', session: {mode: 'new'}});
async function fixture(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'momentread-cli-unit-'));
  const binary = join(cwd, 'claude-test');
  const script = join(cwd, 'fixture.cjs');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(script, body);
  await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
  await chmod(binary, 0o700);
  return {cwd, binary, cleanup: () => rm(cwd, {recursive: true, force: true})};
}
const init = `console.log(JSON.stringify({type:'system',subtype:'init',session_id:process.argv[process.argv.indexOf('--session-id')+1],tools:[],plugins:[],mcp_servers:[]}));`;
const listen = String.raw`let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);handle(message)}});`;
const result = `console.log(JSON.stringify({type:'result',subtype:'success',result:'完成'}));process.stdin.on('end',()=>process.exit(0));`;

describe('Claude NDJSON protocol', () => {
  it('preserves UTF-8 split at every byte and accepts final line without newline', () => {
    const messages: unknown[] = [];
    const decoder = new JsonLineDecoder(value => messages.push(value));
    for (const byte of Buffer.from('{"text":"中文🙂"}\n{"text":"最后"}')) decoder.push(Buffer.from([byte]));
    decoder.end();
    expect(messages).toEqual([{text: '中文🙂'}, {text: '最后'}]);
  });
  it('rejects malformed or unbounded protocol frames', () => {
    expect(() => new JsonLineDecoder(() => {}).push(Buffer.from('not-json\n'))).toThrow();
    expect(() => new JsonLineDecoder(() => {}, 4).push(Buffer.from('12345'))).toThrow('CLI_PROTOCOL_LIMIT');
  });
  it('does not duplicate deltas in assistant snapshots or repeated snapshots', () => {
    const text = new TextAccumulator();
    text.consume({type: 'stream_event', event: {type: 'message_start', message: {id: 'a'}}});
    expect(text.consume({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: '中文'}}})).toBe('中文');
    const snapshot = {type: 'assistant', message: {id: 'a', content: [{type: 'text', text: '中文完整'}]}};
    expect(text.consume(snapshot)).toBe('完整');
    expect(text.consume(snapshot)).toBe('');
    expect(text.text).toBe('中文完整');
  });
  it('supports snapshots without partial events and ignores subagent text', () => {
    const text = new TextAccumulator();
    expect(text.consume({type: 'assistant', message: {id: 'a', content: [{type: 'text', text: '只有快照'}]}})).toBe('只有快照');
    expect(text.consume({type: 'assistant', parent_tool_use_id: 'tool', message: {id: 'b', content: [{type: 'text', text: '不属于主运行'}]}})).toBe('');
  });
  it('redacts credentials, endpoint query strings, and personal paths', () => {
    const redacted = redactDiagnostic('token=very-secret Bearer abc123 /Users/person/.claude/config https://host?key=secret sk-ant-very-secret');
    expect(redacted).not.toContain('very-secret'); expect(redacted).not.toContain('person'); expect(redacted).not.toContain('host'); expect(redacted).not.toContain('abc123');
  });
  it('classifies quota errors with a strict reset timestamp, not raw provider prose', () => {
    const failure = classifyCliFailure('rate_limit', undefined, 'API Error: Request rejected (429) · You have exceeded the 5-hour usage quota. It will reset at 2026-09-10 21:06:28 +0800 CST. token=secret https://private?key=secret');
    expect(failure).toMatchObject({code: 'CLI_RATE_LIMIT', errorCategory: 'rate_limit', status: 429});
    expect(failure.message).toContain('2026-09-10 21:06:28 +0800');
    expect(JSON.stringify(failure)).not.toContain('secret'); expect(JSON.stringify(failure)).not.toContain('private');
    expect(classifyCliFailure('token=secret', 401)).toMatchObject({code: 'CLI_AUTH_REQUIRED', errorCategory: 'authentication_failed'});
    expect(classifyCliFailure('token=secret', undefined)).toMatchObject({code: 'CLI_RUN_FAILED', errorCategory: 'unknown'});
  });
  it('counts explicit search result links, excluding query URLs and reminder links', () => {
    const query = 'https://query.example/path';
    const header = `Web search results for query: "${query}"\n\n`;
    expect(webSearchResultCount(header + '\nREMINDER: cite [help](https://reminder.example)', query)).toBe(0);
    expect(webSearchResultCount(header + 'Links: [{"title":"Book","url":"https://source.example/book"}]\n[Book](https://source.example/book)\n[Second](https://source.example/second)\nREMINDER: cite sources', query)).toBe(2);
    expect(webSearchResultCount('Unsupported response with https://random.example')).toBeUndefined();
    expect(webSearchResultCount([{type: 'text', text: header + 'Links: [{"url":"https://source.example/book"}]'}], query)).toBe(1);
  });
});

describe('Claude process policy', () => {
  it('enables only matching network tools and never bypasses permissions', () => {
    for (const purpose of ['discussion', 'summary', 'daily', 'matching'] as const) {
      const args = claudeArguments(request(purpose), randomUUID());
      expect(args).toContain('--safe-mode'); expect(args).toContain('--strict-mcp-config');
      expect(args[args.indexOf('--tools') + 1]).toBe(purpose === 'matching' ? 'WebSearch,WebFetch' : '');
      expect(args.join(' ')).not.toMatch(/bypass|dangerously|--continue/);
    }
  });
  it('resumes only an explicit session and never forks an arbitrary conversation', () => {
    const id = randomUUID(); const req = {...request(), session: {mode: 'resume' as const, cliSessionId: id}};
    const args = claudeArguments(req, id);
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', id]);
    expect(args).not.toContain('--session-id'); expect(args).not.toContain('--fork-session');
  });
  it('assigns ordered events to the requested discussion and waits for a clean exit', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const req = request(); const handle = await adapter.start(req); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.map(event => event.seq)).toEqual([1, 2]);
      expect(events.every(event => event.bookId === req.bookId && event.discussionId === req.discussionId && event.runId === req.runId)).toBe(true);
      expect(events.at(-1)).toMatchObject({type: 'completed', data: {text: '完成', sessionReusable: true}});
    } finally { await fake.cleanup(); }
  });
  it('rejects unapproved tools in init before a response can complete', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){console.log(JSON.stringify({type:'system',subtype:'init',session_id:process.argv[process.argv.indexOf('--session-id')+1],tools:['Bash']}));${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'failed', data: {code: 'CLI_ISOLATION_FAILED', sessionReusable: false}});
    } finally { await fake.cleanup(); }
  });
  it.each(['allowOnce', 'deny'] as const)('round-trips host permission %s without persistent grants', async decision => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'WebFetch',input:{url:'https://example.org'}}}));}if(m.type==='control_response'){const r=m.response.response;if(r.updatedPermissions)process.exit(2);console.log(JSON.stringify({type:'result',subtype:'success',result:r.behavior+(r.updatedInput?':'+r.updatedInput.url:'')}));process.stdin.on('end',()=>process.exit(0));}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const req = request('matching'); const handle = await adapter.start(req); const events: RunEvent[] = [];
      for await (const event of handle.events) { events.push(event); if (event.type === 'permission_required') await adapter.answerPermission(req.runId, String(event.data.requestId), decision); }
      expect(events.at(-1)).toMatchObject({type: 'completed', data: {text: decision === 'allowOnce' ? 'allow:https://example.org' : 'deny'}});
      expect(events.some(event => event.type === 'permission_resolved' && event.data.decision === decision)).toBe(true);
      await expect(adapter.answerPermission(req.runId, 'permission-1', decision)).rejects.toMatchObject({code: 'PERMISSION_EXPIRED'});
    } finally { await fake.cleanup(); }
  });
  it('cancels an uncooperative process and marks its session unsafe to resume', async () => {
    const fake = await fixture(`${listen}process.on('SIGINT',()=>{});function handle(m){if(m.type==='user'){${init}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 30});
      const req = request(); const handle = await adapter.start(req); const events: RunEvent[] = [];
      for await (const event of handle.events) { events.push(event); if (event.type === 'initialized') void adapter.cancel(req.runId); }
      expect(events.at(-1)).toMatchObject({type: 'cancelled', data: {forced: true, sessionReusable: false}});
      expect(events.filter(event => ['completed', 'cancelled', 'failed'].includes(event.type))).toHaveLength(1);
    } finally { await fake.cleanup(); }
  });
  it('does not call an abnormal exit a successful result', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'result',subtype:'success',result:'not persisted'}));process.exitCode=1;process.stdin.on('end',()=>process.exit(1));}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'failed', data: {sessionReusable: false}});
    } finally { await fake.cleanup(); }
  });
  it('reserves a discussion before asynchronous process setup and can cancel before spawn', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const req = request(); const first = adapter.start(req);
      await expect(adapter.start({...req, runId: randomUUID()})).rejects.toMatchObject({code: 'RUN_CONFLICT'});
      const cancelling = adapter.cancel(req.runId);
      const handle = await first; const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      await cancelling;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({type: 'cancelled', data: {forced: false, sessionReusable: false}});
    } finally { await fake.cleanup(); }
  });
  it('records actual tool failure separately from a successful assistant completion', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'assistant',message:{id:'tool-call',content:[{type:'tool_use',id:'tool-1',name:'WebSearch',input:{query:'test'}}]}}));console.log(JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',is_error:true,content:'403 Access denied'}]}}));${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request('matching')); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'completed', data: {toolResults: [{toolName: 'WebSearch', success: false, errorCode: 'HTTP_403'}]}});
    } finally { await fake.cleanup(); }
  });
  it('times out silent processes rather than leaving a running task forever', async () => {
    const fake = await fixture(`${listen}function handle(){}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 30, shutdownGraceMs: 30});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'failed', data: {code: 'CLI_TIMEOUT', sessionReusable: false}});
    } finally { await fake.cleanup(); }
  });
  it('does not emit synthetic CLI API errors as assistant text and classifies retries safely', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:500,error:'rate_limit',error_status:429}));console.log(JSON.stringify({type:'assistant',error:'rate_limit',isApiErrorMessage:true,message:{id:'synthetic',content:[{type:'text',text:'API Error: Request rejected (429). It will reset at 2026-09-10 21:06:28 +0800 CST. token=secret https://internal?key=secret'}]}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'secret'}));process.stdin.on('end',()=>process.exit(0));}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.some(event => event.type === 'text_delta')).toBe(false);
      expect(events.find(event => event.type === 'retrying')).toMatchObject({data: {errorCategory: 'rate_limit', status: 429}});
      expect(events.at(-1)).toMatchObject({type: 'failed', data: {code: 'CLI_RATE_LIMIT', errorCategory: 'rate_limit', status: 429, sessionReusable: false}});
      expect(JSON.stringify(events)).not.toContain('secret'); expect(JSON.stringify(events)).not.toContain('internal');
    } finally { await fake.cleanup(); }
  });
  it('allows recovery after a retry and does not classify ordinary quoted error text', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:1,error:'server_error',error_status:500}));console.log(JSON.stringify({type:'assistant',message:{id:'normal',content:[{type:'text',text:'Example: API Error: 429 is an error label.'}]}}));${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.find(event => event.type === 'text_delta')).toMatchObject({data: {text: 'Example: API Error: 429 is an error label.'}});
      expect(events.at(-1)).toMatchObject({type: 'completed', data: {sessionReusable: true}});
    } finally { await fake.cleanup(); }
  });
  it('retains a known service error category when the application deadline interrupts retries', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:5000,error:'rate_limit',error_status:429}));}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 1000, shutdownGraceMs: 100});
      const handle = await adapter.start(request()); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'failed', data: {code: 'CLI_RATE_LIMIT', errorCategory: 'rate_limit', status: 429, sessionReusable: false}});
    } finally { await fake.cleanup(); }
  });
  it('reports a completed but empty WebSearch as zero result links', async () => {
    const fake = await fixture(`${listen}function handle(m){if(m.type==='user'){${init}console.log(JSON.stringify({type:'assistant',message:{id:'search',content:[{type:'tool_use',id:'search-1',name:'WebSearch',input:{query:'https://query.example'}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'search-1',content:'Web search results for query: "https://query.example"\\n\\n\\nREMINDER: include sources.'}]}}));${result}}}`);
    try {
      const adapter = createClaudeAdapter({...fake, maxRunMs: 2000, shutdownGraceMs: 100});
      const handle = await adapter.start(request('matching')); const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({type: 'completed', data: {toolResults: [{toolName: 'WebSearch', success: true, resultCount: 0}]}});
    } finally { await fake.cleanup(); }
  });
});
