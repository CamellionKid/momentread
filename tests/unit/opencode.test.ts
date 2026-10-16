import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, writeFile, chmod, rm, realpath, mkdir, symlink, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOpencodeAdapter, classifyOpencodeFailure, extractStructuredOutput, opencodeArguments, opencodeInput, parseModels} from '../../server/ai/opencode';
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
if(process.env.FIXTURE_ERROR){emit({type:'error',error:JSON.parse(process.env.FIXTURE_ERROR)});process.exit(Number(process.env.FIXTURE_EXIT??1))}
emit({type:'step_start',part:{id:'p0',type:'step-start'}});
const text=process.env.FIXTURE_ECHO_ENV?'PWD='+process.env.PWD+' CWD='+process.cwd()+' DIR='+args[args.indexOf('--dir')+1]:(process.env.FIXTURE_TEXT||'\\u5408\\u6210\\u56de\\u7b54');
emit({type:'text',part:{id:'p1',type:'text',text}});
emit({type:'step_finish',part:{id:'p2',type:'step-finish',reason:'stop'}});
process.exit(Number(process.env.FIXTURE_EXIT??0));
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
  it.each([
    '右括号 } 是文字',
    '左括号 { 是文字',
    '带有转义引号 " 和反斜杠 \\ 的 {文字}',
  ])('extracts fenced JSON without counting braces inside strings: %s', content => {
    const output = {content, nested: {items: [{value: '}'}, {value: '{'}]}};
    expect(extractStructuredOutput('```json\n' + JSON.stringify(output) + '\n```')).toEqual(output);
  });
});

describe('opencode adapter process lifecycle', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    delete process.env.FIXTURE_TEXT; delete process.env.FIXTURE_SESSION;
    delete process.env.FIXTURE_ERROR; delete process.env.FIXTURE_EXIT; delete process.env.FIXTURE_ECHO_ENV;
    await cleanup?.(); cleanup = undefined;
  });
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
  it.each(['', ' \n\t'])('does not report an empty version as a working installation (%j)', async version => {
    const f = await fixture();
    cleanup = f.cleanup;
    await writeFile(join(f.cwd, 'fixture.cjs'), `process.stdout.write(${JSON.stringify(version)});`);
    const ai = createOpencodeAdapter({binary: f.binary, cwd: f.cwd});
    expect(await ai.probe()).toMatchObject({installed: false, version: null, authReported: false, invocationVerified: false, provider: 'opencode', message: '未找到可正常启动的 opencode，请按 README 检查安装。'});
  });
  it('cancels a running process', async () => {
    const ai = await adapter();
    const handle = await ai.start(request());
    await ai.cancel(handle.runId);
    const events = await collect(handle.events);
    expect(['cancelled', 'completed']).toContain(events.at(-1)?.type);
  });
  it('honors cancellation while the adapter is preparing to spawn', async () => {
    const ai = await adapter();
    const input = request();
    const starting = ai.start(input);
    await ai.cancel(input.runId);
    const events = await collect((await starting).events);
    expect(events.map(event => event.type)).toEqual(['cancelled']);
    expect(events[0].data.sessionReusable).toBe(false);
    expect((await ai.probe()).invocationVerified).toBe(false);
  });
  it('removes a long-input attachment when startup is cancelled', async () => {
    const f = await fixture();
    cleanup = f.cleanup;
    const ai = createOpencodeAdapter({binary: f.binary, cwd: f.cwd});
    const input = request({input: '合成内容'.repeat(40000)});
    const starting = ai.start(input);
    await ai.cancel(input.runId);
    expect((await collect((await starting).events)).map(event => event.type)).toEqual(['cancelled']);
    expect((await readdir(f.cwd)).filter(name => name.startsWith('input-'))).toEqual([]);
  });
  it('releases the startup reservation after configuration failure', async () => {
    const f = await fixture();
    cleanup = f.cleanup;
    const blocked = join(f.cwd, 'not-a-directory');
    await writeFile(blocked, 'synthetic marker');
    const ai = createOpencodeAdapter({binary: f.binary, cwd: blocked});
    const input = request();
    await expect(ai.start(input)).rejects.toMatchObject({code: 'EEXIST'});
    await ai.cancel(input.runId);
    await expect(ai.start(input)).rejects.toMatchObject({code: 'EEXIST'});
  });
  it('reserves the discussion before asynchronous startup work', async () => {
    const ai = await adapter();
    const input = request();
    const first = ai.start(input);
    const second = ai.start({...input, runId: randomUUID()});
    const results = await Promise.allSettled([first, second]);
    // Always drain fixture processes, even on the buggy implementation.
    for (const result of results) if (result.status === 'fulfilled') await collect(result.value.events);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({status: 'rejected', reason: {code: 'RUN_CONFLICT'}});
  });
  it('rejects permission answers because opencode has no permission protocol', async () => {
    const ai = await adapter();
    await expect(ai.answerPermission('run', 'req', 'allowRun')).rejects.toMatchObject({code: 'PERMISSION_EXPIRED'});
  });
  it('fails a run that emitted step_finish but exited non-zero', async () => {
    process.env.FIXTURE_EXIT = '1';
    const ai = await adapter();
    const events = await collect((await ai.start(request())).events);
    expect(events.at(-1)?.type).toBe('failed');
    expect(events.at(-1)?.data.code).toBe('CLI_RUN_FAILED');
    expect((await ai.probe()).invocationVerified).toBe(false);
  });
  it('marks the invocation verified only after a complete successful run', async () => {
    const ai = await adapter();
    expect((await ai.probe()).invocationVerified).toBe(false);
    const events = await collect((await ai.start(request())).events);
    expect(events.at(-1)?.type).toBe('completed');
    expect((await ai.probe()).invocationVerified).toBe(true);
  });
  it('surfaces nested error events with classification and reference, not raw text', async () => {
    process.env.FIXTURE_ERROR = JSON.stringify({name: 'UnknownError', data: {message: 'Request failed with status code 429 from https://gateway.internal/v1 with key sk-leaked123', statusCode: 429, requestID: 'req_test123'}});
    const ai = await adapter();
    const events = await collect((await ai.start(request())).events);
    const last = events.at(-1);
    expect(last?.type).toBe('failed');
    expect(last?.data).toMatchObject({code: 'CLI_RATE_LIMIT', status: 429, errorName: 'UnknownError', requestId: 'req_test123'});
    expect(String(last?.data.message)).not.toContain('429');
    expect(String(last?.data.message)).not.toContain('sk-leaked123');
    expect(String(last?.data.message)).not.toContain('https://');
  });
});

describe('opencode run directory pinning', () => {
  it('passes the adapter directory as PWD and --dir even when the parent PWD differs', async () => {
    const spaced = await mkdtemp(join(tmpdir(), 'moment read spaced-'));
    try {
      const script = join(spaced, 'fixture.cjs');
      const binary = join(spaced, 'opencode-test');
      await writeFile(script, fixtureScript);
      await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
      await chmod(binary, 0o700);
      const savedPwd = process.env.PWD;
      process.env.PWD = '/deliberately/wrong';
      process.env.FIXTURE_ECHO_ENV = '1';
      try {
        const ai = createOpencodeAdapter({binary, cwd: spaced, maxRunMs: 15000});
        const events = await collect((await ai.start(request())).events);
        expect(events.at(-1)?.type).toBe('completed');
        const text = String(events.at(-1)?.data.text);
        const expected = await realpath(spaced);
        expect(text).toContain(`PWD=${spaced}`);
        expect(text).toContain(`DIR=${spaced}`);
        expect(text).toContain(`CWD=${expected}`);
        expect(text).not.toContain('/deliberately/wrong');
      } finally {
        process.env.PWD = savedPwd;
        delete process.env.FIXTURE_ECHO_ENV;
      }
    } finally {
      await rm(spaced, {recursive: true, force: true});
    }
  });
});

describe('opencode installation selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function install(directory: string, script: string) {
    await mkdir(directory, {recursive: true});
    const binary = join(directory, 'opencode');
    await writeFile(binary, script, {mode: 0o700});
    return binary;
  }

  it('does not report a silent successful launcher as installed', async () => {
    const f = await fixture();
    try {
      const binary = await install(join(f.cwd, 'broken'), '#!/bin/sh\nexit 0\n');
      const ai = createOpencodeAdapter({binary, cwd: f.cwd});
      expect(await ai.probe()).toMatchObject({installed: false, version: null, authReported: false});
      expect(await ai.models?.()).toEqual([]);
      await expect(ai.start(request())).rejects.toMatchObject({code: 'CLI_NOT_INSTALLED'});
    } finally { await f.cleanup(); }
  });

  it('prefers the standalone installation and pins it across PATH changes', async () => {
    const f = await fixture();
    try {
      const preferred = join(f.cwd, '.opencode/bin');
      await mkdir(preferred, {recursive: true});
      await symlink(f.binary, join(preferred, 'opencode'));
      const other = join(f.cwd, 'other');
      await install(other, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.0; fi\nexit 0\n');
      vi.stubEnv('HOME', f.cwd);
      vi.stubEnv('PATH', other);
      const ai = createOpencodeAdapter({cwd: f.cwd});
      expect(await ai.probe()).toMatchObject({installed: true, version: '1.18.25-test'});
      vi.stubEnv('HOME', join(f.cwd, 'missing-home'));
      vi.stubEnv('PATH', other);
      expect(await ai.models?.()).toContain('opencode-go/deepseek-v4-flash');
      const events = await collect((await ai.start(request())).events);
      expect(events.at(-1)?.type).toBe('completed');
    } finally { await f.cleanup(); }
  });

  it('skips broken candidates and uses a working CLI later in PATH', async () => {
    const f = await fixture();
    try {
      await install(join(f.cwd, '.opencode/bin'), '#!/bin/sh\nexit 1\n');
      const bad = join(f.cwd, 'bad');
      await install(bad, '#!/bin/sh\nexit 0\n');
      const good = join(f.cwd, 'good');
      await mkdir(good);
      await symlink(f.binary, join(good, 'opencode'));
      vi.stubEnv('HOME', f.cwd);
      vi.stubEnv('PATH', `${bad}:${good}`);
      const ai = createOpencodeAdapter({cwd: f.cwd});
      expect(await ai.probe()).toMatchObject({installed: true, version: '1.18.25-test'});
      const events = await collect((await ai.start(request())).events);
      expect(events.at(-1)?.type).toBe('completed');
    } finally { await f.cleanup(); }
  });
});

describe('opencode error classification', () => {
  it('reads the nested error.data message and extracts status and request id', () => {
    const failure = classifyOpencodeFailure('UnknownError', 'Request failed with status code 429', 429, 'req_abc123');
    expect(failure).toMatchObject({code: 'CLI_RATE_LIMIT', errorName: 'UnknownError', status: 429, requestId: 'req_abc123'});
  });
  it('classifies authentication failures from status or wording', () => {
    expect(classifyOpencodeFailure('APIError', 'authentication failed: invalid api key', 401, undefined).code).toBe('CLI_AUTH_REQUIRED');
    expect(classifyOpencodeFailure(undefined, 'Not logged in', undefined, undefined).code).toBe('CLI_AUTH_REQUIRED');
  });
  it('classifies missing models and broken agent configuration', () => {
    expect(classifyOpencodeFailure(undefined, 'model "x/y" not found', 404, undefined).code).toBe('CLI_MODEL_UNAVAILABLE');
    expect(classifyOpencodeFailure(undefined, 'agent momentread not found in config', undefined, undefined).code).toBe('CLI_CONFIG_INVALID');
  });
  it('keeps unknown failures generic and never leaks details into the message', () => {
    const failure = classifyOpencodeFailure('Weird', 'sk-ant-secret123 at /Users/darren/private/path', undefined, undefined);
    expect(failure.code).toBe('CLI_RUN_FAILED');
    expect(failure.message).not.toContain('sk-');
    expect(failure.message).not.toContain('/Users');
  });
});
