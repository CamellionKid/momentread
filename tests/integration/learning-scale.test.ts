import {expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore} from '../../server/storage/index';
import {createLearningService} from '../../server/learning/index';
import {now, type Message, type TextReference} from '../../shared/contracts/index';

it('persists 500 nodes including a 20-level path, isolated drafts and exact parent receipts across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momentread-learning-scale-')); let store = createStore(dir);
  try {
    const book = {id: randomUUID(), title: 'Generated 500-node fixture', author: 'Test', language: 'zh', fileVersionId: randomUUID(), createdAt: now()};
    store.put('books', book); store.put('files', {id: book.fileVersionId, bookId: book.id, filename: 'fixture.epub', mediaType: 'application/epub+zip', sha256: 'fixture', relativePath: 'books/fixture.epub', size: 1, role: 'book', createdAt: now()});
    let service = createLearningService(store);
    const source: TextReference = {bookId: book.id, fileVersionId: book.fileVersionId, segments: [{spineId: 'chapter1', chapter: 'Chapter 1', cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:6)', exact: '合成测试文字', prefix: '', suffix: ''}]};
    const root = service.createRoot({source, question: '合成测试'});
    // Messages are protocol-independent fixtures. API integration tests separately
    // cover real run ownership and appendAssistant; no private or model data used.
    const message = (id: string): Message => {const m: Message = {id: randomUUID(), bookId: book.id, discussionId: id, role: 'assistant', text: '概念', status: 'complete', runId: null, createdAt: now()}; store.put('messages', m); return m;};
    const rootMessage = message(root.id); let deepest = root;
    for (let depth = 1; depth < 20; depth++) {
      const m = depth === 1 ? rootMessage : message(deepest.id);
      deepest = service.createBranch({parentId: deepest.id, title: `层级${depth}`, origin: {messageId: m.id, start: 0, end: 2, exact: '概念'}});
      service.updateDiscussion(deepest.id, {draft: `层级${depth}独立草稿`, scrollTop: depth * 10});
    }
    for (let count = 20; count < 500; count++) service.createBranch({parentId: root.id, title: `兄弟${count}`, origin: {messageId: rootMessage.id, start: 0, end: 2, exact: '概念'}});
    const before = store.list('discussions', book.id); expect(before).toHaveLength(500);
    const context = service.buildInput(deepest.id, 'summary'); expect(JSON.parse(context.input).ancestors).toHaveLength(19);
    const draft = service.createSummaryDraft(context.id, '最深层保存结果');
    const result = service.confirmSummary(draft.id, {requestId: randomUUID(), content: '最深层保存结果'}); expect(result.parentId).toBe(deepest.parentId);
    expect(store.list('receipts', book.id)).toHaveLength(1); expect(store.list('receipts', book.id)[0].parentId).not.toBe(root.id);
    store.close(); store = createStore(dir); service = createLearningService(store);
    expect(store.list('discussions', book.id)).toHaveLength(500); expect(store.get('discussions', deepest.id)?.draft).toBe('层级19独立草稿');
    expect(JSON.parse(service.buildInput(deepest.id, 'discussion').input).ancestors).toHaveLength(19);
  } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
}, 15000);
