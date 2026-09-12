import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOpencodeAdapter, extractStructuredOutput, opencodeArguments, opencodeInput, parseModels} from '../../server/ai/opencode';
import type {StartRun} from '../../shared/contracts/ports';
import type {RunEvent} from '../../shared/contracts/index';

const request = (overrides: Partial<StartRun> = {}): StartRun => ({runId: randomUUID(), bookId: randomUUID(), discussionId: randomUUID(), purpose: 'discussion', contextSnapshotId: randomUUID(), input: '合成测试', session: {mode: 'new'}, ...overrides});

const fixtureScript = `
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('1.18.25-test');process.exit(0)}
if(args[0]==='auth'){console.log('\\u25cf  test api\\n\\u2514 2 credentials');process.exit(0)}
if(args[0]==='models'){console.log('opencode-go/deepseek-v4-flash\\nzijie/doubao-x\\n');process.exit(0)}
const session=process.env.FIXTURE_SESSION||(args.includes('-s')?args[args.indexOf('-s')+1]:'ses_fixture123');
const emit=value=>console.log(JSON.stringify({timestamp:Date.now(),sessionID:session,...value}));
emit({type:'step_start',part:{id:'p0',type:'step-start'}});
emit({type:'text',part:{id:'p1',type:'text',text:process.env.FIXTURE_TEXT||'\\u5408\\u6210\\u56de\\u7b54'}});
emit({type:'step_finish',part:{id:'p2',type:'step-finish',reason:'stop'}});
process.exit(0);
`;
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'momentread-opencode-unit-'));
  const binary = join(cwd, 'opencode-test');
  const script = join(cwd, 'fixture.cjs');
  await writeFile(script, fixtureScript);
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(binary, 0o700);
  return {cwd, binary, cleanup: () => rm(cwd, {recursive: true, force: true})};
}
async function collect(events: AsyncIterable<RunEvent>) {
  const seen: RunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('opencode adapter arguments and helpers', () => {
  it('runs headless with the isolated agent, session resume, and model passthrough', () => {
    const fresh = opencodeArguments(request(), undefined, '/tmp/run dir');
    expect(fresh.slice(0, 4)).toEqual(['run', '--format', 'json', '--pure']);
    expect(fresh).toContain('momentread');
    expect(fresh).not.toContain('-s');
    expect(fresh[fresh.indexOf('--dir') + 1]).toBe('/tmp/run dir');
    const resumed = opencodeArguments(request({session: {mode: 'resume', cliSessionId: 'ses_abc'}}), 'opencode-go/deepseek-v4-flash', '/tmp/run dir');
    expect(resumed).toContain('-s');
    expect(resumed[resumed.indexOf('-s') + 1]).toBe('ses_abc');
    expect(resumed[resumed.indexOf('-m') + 1]).toBe('opencode-go/deepseek-v4-flash');
  });
  it('appends the schema instruction only for structured runs', () => {
    expect(opencodeInput(request())).toBe('合成测试');
    const structured = opencodeInput(request({outputSchema: {type: 'object', properties: {content: {type: 'string'}}}}));
    expect(structured).toContain('合成测试');
    expect(structured).toContain('JSON Schema');
    expect(structured).toContain('"content"');
  });
  it('extracts the first JSON object from direct or embedded text', () => {
    expect(extractStructuredOutput('{"content":"小结"}')).toEqual({content: '小结'});
    expect(extractStructuredOutput('前言 {"content":"小结"} 后记')).toEqual({content: '小结'});
    expect(extractStructuredOutput('没有结构')).toBeUndefined();
    expect(extractStructuredOutput('[1,2]')).toBeUndefined();
    expect(extractStructuredOutput('{"content": 未闭合')).toBeUndefined();
  });
  it('parses provider/model lines from models output', () => {
    expect(parseModels('opencode-go/deepseek-v4-flash\nzijie/doubao-x\n\nnot a model line\n')).toEqual(['opencode-go/deepseek-v4-flash', 'zijie/doubao-x']);
    expect(parseModels('')).toEqual([]);
  });
});

describe('opencode adapter process lifecycle', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { delete process.env.FIXTURE_TEXT; delete process.env.FIXTURE_SESSION; await cleanup?.(); cleanup = undefined; });
  const adapter = async () => {
    const f = await fixture();
    cleanup = f.cleanup;
    return createOpencodeAdapter({binary: f.binary, cwd: f.cwd, maxRunMs: 15000});
  };
  it('maps step/text events to initialized, text_delta, and completed', async () => {
    const ai = await adapter();
    const handle = await ai.start(request());
    const events = await collect(handle.events);
    expect(events.map(event => event.type)).toEqual(['initialized', 'text_delta', 'completed']);
    expect(events[0].data.cliSessionId).toBe('ses_fixture123');
    expect(events[1].data.text).toBe('合成回答');
    expect(events[2].data).toMatchObject({text: '合成回答', sessionReusable: true});
  });
  it('resumes an existing session when the CLI confirms the same id', async () => {
    const ai = await adapter();
    const handle = await ai.start(request({session: {mode: 'resume', cliSessionId: 'ses_fixture123'}}));
    const events = await collect(handle.events);
    expect(events.at(-1)?.type).toBe('completed');
  });
  it('fails when the CLI continues a different session', async () => {
    process.env.FIXTURE_SESSION = 'ses_fixture123';
    const ai = await adapter();
    const handle = await ai.start(request({session: {mode: 'resume', cliSessionId: 'ses_other'}}));
    const events = await collect(handle.events);
    expect(events.at(-1)?.type).toBe('failed');
    expect(events.at(-1)?.data.code).toBe('CLI_SESSION_MISMATCH');
  });
  it('rejects matching runs as unsupported', async () => {
    const ai = await adapter();
    await expect(ai.start(request({purpose: 'matching'}))).rejects.toMatchObject({code: 'MATCHING_UNSUPPORTED'});
  });
  it('parses structured output from the final text', async () => {
    process.env.FIXTURE_TEXT = '{"content":"小结内容"}';
    const ai = await adapter();
    const handle = await ai.start(request({purpose: 'summary', outputSchema: {type: 'object', properties: {content: {type: 'string'}}}}));
    const events = await collect(handle.events);
    expect(events.at(-1)?.type).toBe('completed');
    expect(events.at(-1)?.data.structuredOutput).toEqual({content: '小结内容'});
  });
  it('fails structured runs when the final text is not JSON', async () => {
    process.env.FIXTURE_TEXT = '这不是 JSON';
    const ai = await adapter();
    const handle = await ai.start(request({purpose: 'summary', outputSchema: {type: 'object'}}));
    const events = await collect(handle.events);
    expect(events.at(-1)?.type).toBe('failed');
  });
  it('reports installation, version, auth, and models through probe', async () => {
    const ai = await adapter();
    const probe = await ai.probe();
    expect(probe).toMatchObject({installed: true, version: '1.18.25-test', authReported: true, provider: 'opencode'});
    expect(await ai.models?.()).toEqual(['opencode-go/deepseek-v4-flash', 'zijie/doubao-x']);
  });
  it('cancels a running process', async () => {
    const ai = await adapter();
    const handle = await ai.start(request());
    await ai.cancel(handle.runId);
    const events = await collect(handle.events);
    expect(['cancelled', 'completed']).toContain(events.at(-1)?.type);
  });
  it('rejects permission answers because opencode has no permission protocol', async () => {
    const ai = await adapter();
    await expect(ai.answerPermission('run', 'req', 'allowRun')).rejects.toMatchObject({code: 'PERMISSION_EXPIRED'});
  });
});
