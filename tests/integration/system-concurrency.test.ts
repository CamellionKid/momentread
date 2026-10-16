import {afterEach, describe, expect, it} from 'vitest';
import {ControlledAdapter, importSynthetic, makeHarness, reference, waitFor} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened: Harness[] = [];
afterEach(async () => {for (const h of opened.splice(0)) await h.dispose();});
async function harness() {
  const h = await makeHarness(new ControlledAdapter(), undefined, 'opencode');
  opened.push(h);
  return h;
}

describe('run admission preserves discussion data', () => {
  it('saves only the accepted message when two requests arrive together', async () => {
    const h = await harness();
    const book = await importSynthetic(h);
    const node = h.learning.createRoot({source: reference(book), question: '初始问题'});
    h.adapter.scripts.push(() => {});
    const responses = await Promise.all(['第一个问题', '第二个问题'].map(text =>
      h.request(`/api/discussions/${node.id}/messages`, 'POST', {text})));
    expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
    const accepted = responses.findIndex(r => r.status === 202);
    const state = await h.state(book.id);
    expect(state.messages.filter(m => m.role === 'user').map(m => m.text))
      .toEqual(['初始问题', ['第一个问题', '第二个问题'][accepted]]);
    expect(state.discussions[0].revision).toBe(node.revision + 1);
    expect(h.store.list('contexts', book.id)).toHaveLength(1);
    expect(h.adapter.starts).toHaveLength(1);
  });

  it('retains the draft and history when the global run limit rejects a message', async () => {
    const h = await harness();
    const book = await importSynthetic(h);
    for (let index = 0; index < 3; index++) {
      const node = h.learning.createRoot({source: reference(book), question: '占用名额'});
      h.adapter.scripts.push(() => {});
      expect((await h.request(`/api/discussions/${node.id}/messages`, 'POST', {text: '开始'})).status).toBe(202);
    }
    const target = h.learning.createRoot({source: reference(book), question: '等待提问'});
    h.learning.updateDiscussion(target.id, {draft: '需要保留的草稿'});
    const before = await h.state(book.id);
    const response = await h.request(`/api/discussions/${target.id}/messages`, 'POST', {text: '需要保留的草稿'});
    expect(response.status).toBe(429);
    const after = await h.state(book.id);
    expect(after.messages).toEqual(before.messages);
    expect(after.discussions).toEqual(before.discussions);
  });

  it('does not create a discussion or move the workspace for a rejected analysis', async () => {
    const h = await harness();
    const book = await importSynthetic(h);
    for (let index = 0; index < 3; index++) {
      h.adapter.scripts.push(() => {});
      expect((await h.request('/api/analyses', 'POST', {source: reference(book)})).status).toBe(202);
    }
    const before = await h.state(book.id);
    const contexts = h.store.list('contexts', book.id);
    expect((await h.request('/api/analyses', 'POST', {source: reference(book)})).status).toBe(429);
    expect(await h.state(book.id)).toEqual(before);
    expect(h.store.list('contexts', book.id)).toEqual(contexts);
  });

  it('rolls back the new message when its context cannot be built', async () => {
    const h = await harness();
    const book = await importSynthetic(h);
    const node = h.learning.createRoot({source: reference(book), question: '初始问题'});
    h.learning.appendUser(node.id, '长'.repeat(159000));
    h.learning.updateDiscussion(node.id, {draft: '保留草稿'});
    const before = await h.state(book.id);
    const response = await h.request(`/api/discussions/${node.id}/messages`, 'POST', {text: '问'.repeat(20000)});
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('CONTEXT_LIMIT');
    expect(await h.state(book.id)).toEqual(before);
    expect(h.adapter.starts).toHaveLength(0);
  });

  it('does not create a branch when the global run limit is full', async () => {
    const h = await harness();
    const book = await importSynthetic(h);
    const root = h.learning.createRoot({source: reference(book), question: '根问题'});
    const origin = h.learning.appendUser(root.id, '合成概念');
    for (let index = 0; index < 3; index++) {
      h.adapter.scripts.push(() => {});
      expect((await h.request('/api/analyses', 'POST', {source: reference(book)})).status).toBe(202);
    }
    const before = await h.state(book.id);
    const contexts = h.store.list('contexts', book.id);
    const response = await h.request('/api/branches', 'POST', {
      parentId: root.id, title: '合成概念', origin: {messageId: origin.id, start: 0, end: 4, exact: '合成概念'},
    });
    expect(response.status).toBe(429);
    expect(await h.state(book.id)).toEqual(before);
    expect(h.store.list('contexts', book.id)).toEqual(contexts);
  });

  it.each(['summary', 'matching', 'daily'])('does not persist a context for a busy %s request', async purpose => {
    const h = await makeHarness(new ControlledAdapter());
    opened.push(h);
    const book = await importSynthetic(h);
    const node = h.learning.createRoot({source: reference(book), question: '初始问题'});
    h.adapter.scripts.push(() => {});
    expect((await h.request(`/api/discussions/${node.id}/messages`, 'POST', {text: '占用讨论'})).status).toBe(202);
    const contexts = h.store.list('contexts', book.id);
    const path = purpose === 'daily' ? `/api/books/${book.id}/report` : `/api/discussions/${node.id}/${purpose}`;
    expect((await h.request(path, 'POST')).status).toBe(409);
    expect(h.store.list('contexts', book.id)).toEqual(contexts);
    expect(h.adapter.starts).toHaveLength(1);
  });
});

describe('runtime status snapshot', () => {
  it('does not combine an old probe with a newly selected provider and model', async () => {
    let release!: () => void;
    let probing = false;
    class SlowClaude extends ControlledAdapter {
      async probe() {
        probing = true;
        await new Promise<void>(resolve => {release = resolve;});
        return {installed: true, version: 'claude-test', authReported: true, invocationVerified: false, message: 'Claude'};
      }
    }
    class Opencode extends ControlledAdapter {
      async probe() {return {installed: true, version: 'opencode-test', authReported: true, invocationVerified: false, message: 'OpenCode'};}
      async models() {return ['test/model'];}
    }
    const claude = new SlowClaude();
    const opencode = new Opencode();
    const h = await makeHarness(claude, undefined, 'claude', p => p === 'opencode' ? opencode : claude);
    opened.push(h);
    const reading = h.request('/api/runtime');
    await waitFor(async () => probing, Boolean, 'probe started');
    try {
      expect((await h.request('/api/runtime', 'PATCH', {provider: 'opencode', model: 'test/model'})).status).toBe(200);
    } finally {release();}
    const info = await (await reading).json();
    expect(info).toMatchObject({provider: 'claude', version: 'claude-test', models: [], model: null});
  });
});
