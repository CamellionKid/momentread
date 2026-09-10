import {afterEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLearningService, assertRangeCFI} from '../../server/learning/index';
import {createStore} from '../../server/storage/index';
import {now, type Book, type Discussion, type Run, type SummaryVersion, type TextReference} from '../../shared/contracts/index';
import type {LearningService, Store} from '../../shared/contracts/ports';

const stores: Store[] = []; const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'momentread-learning-')); dirs.push(dir);
  const store = createStore(dir); stores.push(store); const service = createLearningService(store);
  const addBook = (): Book => {const book = {id: randomUUID(), title: 'Synthetic philosophy', author: 'Test author', language: 'zh', fileVersionId: randomUUID(), createdAt: now()}; store.put('books', book); store.put('files', {id: book.fileVersionId, bookId: book.id, filename: 'synthetic.epub', mediaType: 'application/epub+zip', sha256: 'synthetic', relativePath: 'books/synthetic.epub', size: 10, role: 'book', createdAt: now()}); return book;};
  const book = addBook();
  const source = (owner = book): TextReference => ({bookId: owner.id, fileVersionId: owner.fileVersionId, segments: [{spineId: 'chapter-1', chapter: 'Chapter 1', cfi: 'epubcfi(/6/2[chapter-1]!/4/2,/1:0,/1:5)', exact: '理性的不同用法', prefix: '前文', suffix: '后文'}]});
  const root = (owner = book) => service.createRoot({source: source(owner), question: '请解释。'});
  const answer = (node: Discussion, text = '判断包含先验和先天。') => {
    const context = service.buildInput(node.id, 'discussion');
    const run: Run = {id: randomUUID(), bookId: node.bookId, discussionId: node.id, purpose: 'discussion', status: 'running', contextSnapshotId: context.id, sessionId: null, sessionReusable: false, partialText: text, result: null, error: null, createdAt: now(), updatedAt: now()}; store.put('runs', run);
    return service.appendAssistant(node.id, text, run.id);
  };
  const branch = (parent: Discussion, title = '判断') => {const message = answer(parent); const start = message.text.indexOf(title); return service.createBranch({parentId: parent.id, title, origin: {messageId: message.id, start, end: start + title.length, exact: title}});};
  const draft = (node: Discussion, content = '可编辑小结') => service.createSummaryDraft(service.buildInput(node.id, 'summary').id, content);
  const confirm = (node: Discussion, content = '已确认小结') => service.confirmSummary(draft(node).id, {requestId: randomUUID(), content});
  return {dir, store, service, book, addBook, source, root, answer, branch, draft, confirm};
}
afterEach(() => {for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});});

describe('learning source and branch boundaries', () => {
  it('binds a root to its own ID, file version and exact multi-segment source', () => {
    const f = fixture(); const source = f.source(); source.segments.push({...source.segments[0], cfi: 'epubcfi(/6/4[ch2]!/4/2,/1:3,/1:12)', spineId: 'chapter-2'});
    const root = f.service.createRoot({source, question: '解释这两段。'});
    expect(root.rootId).toBe(root.id); expect(root.source).toEqual(source); expect(root.revision).toBe(1);
    expect(f.store.list('messages', f.book.id).map(m => m.text)).toEqual(['解释这两段。']);
  });
  it('rejects another book file, stale file version and malformed reference atomically', () => {
    const f = fixture(); const other = f.addBook();
    expect(() => f.service.createRoot({source: {...f.source(), fileVersionId: other.fileVersionId}, question: 'x'})).toThrow('文件版本');
    for (const cfi of ['text', 'epubcfi(/6/2!/4/2)', 'epubcfi(/6/2!/4/2,/1:8,/1:2)', 'epubcfi(/6/2!/4/2,/1:0garbage,/1:2)', 'epubcfi(/6/2!/4/2,/1:0,/1:2,/1:3)', 'epubcfi(/6/2!/4/2,/1:0,/1:2[broken)']) {
      expect(() => f.service.createRoot({source: {...f.source(), segments: [{...f.source().segments[0], cfi}]}, question: 'x'})).toThrow();
    }
    expect(f.store.list('discussions')).toHaveLength(0); expect(f.store.list('messages')).toHaveLength(0);
  });
  it('supports escaped CFI ID assertions while rejecting ignored parser junk', () => {
    expect(() => assertRangeCFI('epubcfi(/6/2[a^,b^]c]!/4/2,/1:0,/1:8)')).not.toThrow();
    expect(() => assertRangeCFI('epubcfi(/6/2[]!/4/2,/1:0,/1:8)')).not.toThrow();
    expect(() => assertRangeCFI('epubcfi(/6/2!/4/2,/1:0,/1:8)trailing')).toThrow();
  });
  it('validates origin ownership and UTF-16 ranges, and never merges same titles', () => {
    const f = fixture(); const root = f.root(); const other = f.root(f.addBook()); const message = f.answer(root, '😀判断和判断');
    const origin = {messageId: message.id, start: 2, end: 4, exact: '判断'};
    expect(() => f.service.createBranch({parentId: other.id, title: '判断', origin})).toThrow('不一致');
    expect(() => f.service.createBranch({parentId: root.id, title: '判断', origin: {...origin, end: 100}})).toThrow('不一致');
    expect(() => f.service.createBranch({parentId: root.id, title: '判断', origin: {...origin, exact: '先验'}})).toThrow('不一致');
    const a = f.service.createBranch({parentId: root.id, title: '判断', origin}); const b = f.service.createBranch({parentId: root.id, title: '判断', origin});
    expect(a.id).not.toBe(b.id); expect(a.parentId).toBe(root.id); expect(a.rootId).toBe(root.id);
  });
  it('rejects incomplete replies and cyclic or cross-book ancestry', () => {
    const f = fixture(); const root = f.root(); const message = f.answer(root); f.store.put('messages', {...message, status: 'interrupted'});
    expect(() => f.service.createBranch({parentId: root.id, title: '判断', origin: {messageId: message.id, start: 0, end: 2, exact: '判断'}})).toThrow('完整生成');
    f.store.put('discussions', {...root, parentId: root.id});
    expect(() => f.service.buildInput(root.id, 'discussion')).toThrow('循环');
  });
});

describe('frozen context, discussion isolation and message ownership', () => {
  it('freezes ancestors through the origin message, persists that cutoff, excludes sibling full text', () => {
    const f = fixture(); const root = f.root(); const selected = f.answer(root, '先验来自判断');
    f.answer(root, 'PARENT_ALREADY_LATER_SECRET');
    const child = f.service.createBranch({parentId: root.id, title: '先验', origin: {messageId: selected.id, start: 0, end: 2, exact: '先验'}});
    const sibling = f.branch(root, '先天'); f.service.appendUser(sibling.id, 'SIBLING_UNCONFIRMED_SECRET');
    f.answer(root, 'PARENT_FUTURE_SECRET');
    const context = f.service.buildInput(child.id, 'discussion');
    expect(context.input).toContain('先验来自判断'); expect(context.input).not.toContain('PARENT_ALREADY_LATER_SECRET'); expect(context.input).not.toContain('PARENT_FUTURE_SECRET'); expect(context.input).not.toContain('SIBLING_UNCONFIRMED_SECRET');
    expect(context.messageIds).toContain(selected.id); expect(context.discussionRevision).toBe(f.store.get('discussions', child.id)!.revision);
    f.store.close(); const reopened = createStore(f.dir); stores.push(reopened);
    expect(createLearningService(reopened).buildInput(child.id, 'discussion').input).not.toContain('PARENT_FUTURE_SECRET');
  });
  it('passes confirmed child summaries instead of child full messages and keeps dependency metadata', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); f.service.appendUser(child.id, 'CHILD_FULL_TEXT_SECRET');
    const saved = f.confirm(child, '判断的已确认含义'); const context = f.service.buildInput(root.id, 'summary');
    expect(context.input).toContain('判断的已确认含义'); expect(context.input).not.toContain('CHILD_FULL_TEXT_SECRET'); expect(context.summaryDependencies).toContainEqual({summaryId: saved.summary.id, version: 1});
  });
  it('retains independent drafts without changing semantic revisions, and ordinary turns do not create nodes', () => {
    const f = fixture(); const root = f.root(); const a = f.branch(root); const b = f.branch(root); const before = f.store.list('discussions').length;
    const revision = f.store.get('discussions', a.id)!.revision;
    f.service.updateDiscussion(a.id, {draft: 'A草稿', scrollTop: 150}); f.service.updateDiscussion(b.id, {draft: 'B草稿'});
    expect(f.store.get('discussions', a.id)).toMatchObject({draft: 'A草稿', scrollTop: 150, revision});
    f.service.appendUser(a.id, 'A追问'); expect(f.store.get('discussions', a.id)?.draft).toBe(''); expect(f.store.get('discussions', b.id)?.draft).toBe('B草稿'); expect(f.store.list('discussions')).toHaveLength(before);
  });
  it('rejects wrong-owner runs and deduplicates only identical assistant output', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); const answer = f.answer(root, '完整回答');
    expect(() => f.service.appendAssistant(child.id, '串线', answer.runId!)).toThrow('归属');
    expect(f.service.appendAssistant(root.id, answer.text, answer.runId!)).toEqual(answer);
    expect(() => f.service.appendAssistant(root.id, '不同回答', answer.runId!)).toThrow('已经保存');
  });
  it('does not expose unavailable source quotes to the model', () => {
    const f = fixture(); const root = f.root(); const id = randomUUID();
    f.store.put('sources', {id, bookId: f.book.id, discussionId: root.id, fileVersionId: null, language: 'de', title: 'Unretrieved', version: '', locator: '', url: 'https://example.org', quote: 'UNRETRIEVED_FAKE_QUOTE', evidenceHash: '', retrieval: 'fetch_failed', verification: 'unverified', selected: true, reason: 'failed', createdAt: now()});
    const context = f.service.buildInput(root.id, 'discussion'); expect(context.sourceIds).toContain(id); expect(context.input).not.toContain('UNRETRIEVED_FAKE_QUOTE'); expect(context.input).toContain('fetch_failed');
  });
});

describe('transactional summary confirmation', () => {
  it('confirms only to the immediate parent and returns a null parent for the root', () => {
    const f = fixture(); const root = f.root(); const a = f.branch(root); const b = f.branch(a);
    const result = f.confirm(b); expect(result.parentId).toBe(a.id); expect(f.store.list('receipts')).toHaveLength(1); expect(f.store.list('receipts')[0].parentId).toBe(a.id);
    expect(f.store.list('concepts')[0]).toMatchObject({discussionId: b.id, summaryId: result.summary.id});
    expect(f.confirm(root).parentId).toBeNull(); expect(f.store.list('concepts')).toHaveLength(1);
  });
  it('rejects stale previews after new messages and after a child summary arrives', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); const first = f.draft(root);
    f.service.appendUser(root.id, '新的追问'); expect(() => f.service.confirmSummary(first.id, {requestId: randomUUID(), content: 'old'})).toThrow('已有更新');
    const second = f.draft(root); f.confirm(child); expect(() => f.service.confirmSummary(second.id, {requestId: randomUUID(), content: 'old'})).toThrow('已有更新');
    expect(f.store.get('summaries', first.id)?.confirmed).toBe(false);
  });
  it('persists request deduplication, rejects changed payload, and preserves all confirmed versions', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); const draft = f.draft(child); const request = {requestId: randomUUID(), content: '版本一'};
    const first = f.service.confirmSummary(draft.id, request); const original = structuredClone(first.summary);
    expect(f.service.confirmSummary(draft.id, request)).toEqual(first);
    expect(() => f.service.confirmSummary(draft.id, {...request, content: 'different'})).toThrow('不同内容');
    f.store.close(); const reopened = createStore(f.dir); stores.push(reopened); const service = createLearningService(reopened);
    expect(service.confirmSummary(draft.id, request)).toEqual(first);
    const nextDraft = service.createSummaryDraft(service.buildInput(child.id, 'summary').id, '版本二'); const second = service.confirmSummary(nextDraft.id, {requestId: randomUUID(), content: '版本二'});
    expect(second.summary.version).toBe(2); expect(reopened.get('summaries', first.summary.id)).toEqual(original); expect(reopened.list('receipts')).toHaveLength(1); expect(reopened.list('receipts')[0].summaryId).toBe(second.summary.id); expect(reopened.list('concepts')).toHaveLength(2);
  });
  it('allows one of two concurrent previews to confirm and marks parent pending without rewriting it', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); const parent = f.confirm(root, '父讨论旧版本');
    const a = f.draft(child); const b = f.draft(child); f.service.confirmSummary(a.id, {requestId: randomUUID(), content: '子小结'});
    expect(() => f.service.confirmSummary(b.id, {requestId: randomUUID(), content: '另一个预览'})).toThrow('已有更新');
    expect(f.store.get('discussions', root.id)?.needsMerge).toBe(true); expect(f.store.get('summaries', parent.summary.id)?.content).toBe('父讨论旧版本');
    f.confirm(root, '合并后的父小结'); expect(f.store.get('discussions', root.id)?.needsMerge).toBe(false);
  });
  it('detects a changed conceptual dependency even when it is not a direct child', () => {
    const f = fixture(); const root = f.root(); const a = f.branch(root, '判断'); f.confirm(a, '判断版本一');
    const otherRoot = f.root(); const context = f.service.buildInput(otherRoot.id, 'summary', '判断是什么意思'); const preview = f.service.createSummaryDraft(context.id, '依赖旧判断');
    f.confirm(a, '判断版本二'); expect(() => f.service.confirmSummary(preview.id, {requestId: randomUUID(), content: preview.content})).toThrow('已有更新');
  });
  it('rolls back summary, concept, receipt, revisions and idempotency if a domain write fails', () => {
    const f = fixture(); const root = f.root(); const child = f.branch(root); const draft = f.draft(child); const original = f.store.put.bind(f.store); const parentBefore = f.store.get('discussions', root.id); const request = {requestId: randomUUID(), content: '确认内容'};
    f.store.put = ((kind: string, value: unknown) => {if (kind === 'concepts') throw new Error('Injected concept failure'); return original(kind as never, value as never);}) as Store['put'];
    expect(() => f.service.confirmSummary(draft.id, request)).toThrow('Injected'); f.store.put = original;
    expect(f.store.get('summaries', draft.id)?.confirmed).toBe(false); expect(f.store.get('discussions', root.id)).toEqual(parentBefore); expect(f.store.list('receipts')).toHaveLength(0); expect(f.store.getIdempotent(`learning:confirm:${request.requestId}`)).toBeUndefined();
    expect(f.service.confirmSummary(draft.id, request).summary.confirmed).toBe(true);
  });
  it('keeps same-name senses distinct and rejects non-summary contexts', () => {
    const f = fixture(); const root = f.root(); const a = f.branch(root); const b = f.branch(root); f.confirm(a, '语境甲'); f.confirm(b, '语境乙');
    expect(f.store.list('concepts').map(c => c.definition)).toEqual(['语境甲', '语境乙']);
    expect(() => f.service.createSummaryDraft(f.service.buildInput(root.id, 'discussion').id, 'bad')).toThrow('不能用于');
  });
});

describe('persisted source disclosure and optional concept review', () => {
  it('requires a clear foreign-original disclosure when only Chinese or failed retrieval evidence exists', () => {
    const f = fixture(); const root = f.root();
    const noSource = JSON.parse(f.service.buildInput(root.id, 'discussion').input);
    expect(noSource.instructions).toContain('回答必须明确写“尚未核对外文原著”');
    expect(noSource.instructions).toContain('“中文选段依据”');
    expect(noSource.instructions).not.toContain('当前输入包含实际取回的外文来源');
    f.store.put('sources', {id: randomUUID(), bookId: f.book.id, discussionId: root.id, fileVersionId: null, language: 'zh-CN', title: 'Chinese translation', version: 'Chinese edition', locator: 'Chapter 1', url: 'https://example.org/zh', quote: '只有中文译句', evidenceHash: 'fixture', retrieval: 'retrieved', verification: 'confirmed', selected: true, reason: '', createdAt: now()});
    f.store.put('sources', {id: randomUUID(), bookId: f.book.id, discussionId: root.id, fileVersionId: null, language: 'en', title: 'Not fetched', version: '', locator: '', url: 'https://example.org/en', quote: 'UNRETRIEVED_ENGLISH', evidenceHash: '', retrieval: 'fetch_failed', verification: 'unverified', selected: true, reason: 'failed', createdAt: now()});
    const chineseOnly = f.service.buildInput(root.id, 'discussion');
    expect(JSON.parse(chineseOnly.input).instructions).toContain('回答必须明确写“尚未核对外文原著”');
    expect(chineseOnly.input).toContain('只有中文译句'); expect(chineseOnly.input).not.toContain('UNRETRIEVED_ENGLISH');
    expect(f.store.get('contexts', chineseOnly.id)?.input).toBe(chineseOnly.input);
  });
  it('preserves retrieved foreign quotations, attribution and verification without falsely claiming an absent original', () => {
    const f = fixture(); const root = f.root();
    const source = {id: randomUUID(), bookId: f.book.id, discussionId: root.id, fileVersionId: null, language: 'de', title: 'Synthetic German source', version: 'Test edition', locator: 'Section 2', url: 'https://example.org/de', quote: 'Ein synthetischer deutscher Testsatz.', evidenceHash: 'fixture', retrieval: 'retrieved' as const, verification: 'unverified' as const, selected: true, reason: '', createdAt: now()}; f.store.put('sources', source);
    const child = f.branch(root); const input = JSON.parse(f.service.buildInput(child.id, 'discussion').input);
    expect(input.instructions).toContain('当前输入包含实际取回的外文来源'); expect(input.instructions).toContain('外文原著候选，尚未确认对应');
    expect(input.instructions).not.toContain('当前输入未提供可对照的外文原句');
    expect(input.ancestors[0].sources[0]).toMatchObject({quote: source.quote, title: source.title, version: source.version, locator: source.locator, url: source.url, verification: 'unverified'});
  });
  it('retrieves a confirmed sense mentioned in a later question and allows at most one skippable review without sibling disclosure', () => {
    const f = fixture(); const first = f.root(); const learned = f.branch(first, '判断'); const saved = f.confirm(learned, '判断在此处是连接概念的活动。');
    const later = f.root(); const pending = f.branch(later, '先验'); f.service.appendUser(pending.id, 'PENDING_SIBLING_PRIVATE_REASONING');
    f.service.appendUser(later.id, '这一段和以前讨论过的判断有什么关系？');
    const context = f.service.buildInput(later.id, 'discussion'); const input = JSON.parse(context.input);
    expect(input.concepts).toHaveLength(1); expect(input.concepts[0]).toMatchObject({discussionId: learned.id, title: '判断', definition: saved.summary.content});
    expect(context.summaryDependencies).toContainEqual({summaryId: saved.summary.id, version: saved.summary.version});
    expect(input.instructions).toContain('至多 1 个'); expect(input.instructions).toContain('明确标注“可跳过”'); expect(input.instructions).toContain('不要求作答才能继续'); expect(input.instructions).toContain('不评分、不推断掌握程度');
    expect(context.input).not.toContain('PENDING_SIBLING_PRIVATE_REASONING');
    expect(f.store.get('contexts', context.id)?.input).toBe(context.input);
    f.service.appendUser(later.id, '跳过判断的回顾，直接继续解释。');
    const skipped = JSON.parse(f.service.buildInput(later.id, 'discussion').input);
    expect(skipped.current.messages.at(-1).text).toBe('跳过判断的回顾，直接继续解释。');
    expect(skipped.instructions).toContain('本轮不再提出回顾问题，直接继续阅读或解释');
  });
  it('does not introduce concept review into summaries or into discussions without related confirmed senses', () => {
    const f = fixture(); const root = f.root();
    expect(JSON.parse(f.service.buildInput(root.id, 'discussion').input).instructions).not.toContain('至多 1 个');
    const child = f.branch(root, '判断'); f.confirm(child);
    const summary = JSON.parse(f.service.buildInput(root.id, 'summary', '判断').input);
    expect(summary.concepts).toHaveLength(1); expect(summary.instructions).not.toContain('至多 1 个'); expect(summary.instructions).toContain('本次只整理当前讨论');
  });
});
