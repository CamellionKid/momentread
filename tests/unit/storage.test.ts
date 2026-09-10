import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore, readStoreSnapshot, serializeStore} from '../../server/storage/index';
import {now, type Book, type SummaryVersion, type RunEvent} from '../../shared/contracts/index';
import type {Store} from '../../shared/contracts/ports';

const open: Store[] = [];
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'momentread-storage-unit-')); dirs.push(dir);
  const store = createStore(dir); open.push(store);
  return {dir, store};
}
function book(): Book {return {id: randomUUID(),title: 'Synthetic book',author: 'Test',language: 'en',fileVersionId: randomUUID(),createdAt: now()};}
afterEach(() => {for (const store of open.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});});

describe('SQLite store', () => {
  it('validates entities and indexes books under their own bookId', () => {
    const {store} = fixture(); const first = book(); const second = book();
    store.put('books', first); store.put('books', second);
    expect(store.list('books', first.id)).toEqual([first]);
    expect(() => store.put('books', {...first, id: 'invalid'})).toThrow();
  });
  it('rolls back every entity and idempotency result in a failed transaction', () => {
    const {store} = fixture(); const value = book();
    expect(() => store.transaction(() => {store.put('books', value); store.setIdempotent('test', {ok: true}); throw new Error('Injected failure');})).toThrow('Injected failure');
    expect(store.list('books')).toEqual([]); expect(store.getIdempotent('test')).toBeUndefined();
  });
  it('rejects asynchronous transactions and rolls back synchronous mutations', () => {
    const {store} = fixture();
    expect(() => store.transaction(() => {store.put('books', book()); return Promise.resolve(1);})).toThrow('异步');
    expect(store.list('books')).toEqual([]);
  });
  it('persists data, WAL events and idempotency across process handles', () => {
    const {dir, store} = fixture(); const value = book();
    store.put('books', value); store.setIdempotent('request', {id: value.id}); store.close();
    const reopened = createStore(dir); open.push(reopened);
    expect(reopened.get('books', value.id)).toEqual(value);
    expect(reopened.getIdempotent('request')).toEqual({id: value.id});
    expect(() => reopened.setIdempotent('request', {id: 'other'})).toThrow('标识');
  });
  it('keeps confirmed summary versions immutable but permits the same idempotent write', () => {
    const {store} = fixture();
    const summary: SummaryVersion = {id: randomUUID(),bookId: randomUUID(),discussionId: randomUUID(),version: 1,content: 'Confirmed',confirmed: true,baseRevision: 1,dependencies: [],sourceIds: [],createdAt: now(),confirmedAt: now()};
    store.put('summaries', summary); store.put('summaries', summary);
    expect(() => store.put('summaries', {...summary,content: 'Changed'})).toThrow('覆盖');
    expect(() => store.remove('summaries', summary.id)).toThrow('删除');
  });
  it('keeps event ordering, retry deduplication and run ownership', () => {
    const {store} = fixture();
    const base: RunEvent = {runId: randomUUID(),bookId: randomUUID(),discussionId: randomUUID(),seq: 0,type: 'initialized',data: {},createdAt: now()};
    store.appendEvent(base); store.appendEvent({...base, seq: 2, type: 'completed'}); store.appendEvent({...base, seq: 1, type: 'text_delta', data: {text: 'Hi'}}); store.appendEvent(base);
    expect(store.events(base.runId).map(e => e.seq)).toEqual([0, 1, 2]);
    expect(store.events(base.runId, 1).map(e => e.seq)).toEqual([2]);
    expect(() => store.appendEvent({...base, data: {different: true}})).toThrow('序号');
    expect(() => store.appendEvent({...base, seq: 3, bookId: randomUUID()})).toThrow('归属');
  });
  it('serializes consistent committed SQLite data', () => {
    const {store} = fixture(); const value = book(); store.put('books', value);
    const snapshot = readStoreSnapshot(serializeStore(store));
    expect(JSON.parse(snapshot.entities[0].data)).toEqual(value);
    expect(() => readStoreSnapshot(new Uint8Array([1, 2]))).toThrow('数据库');
  });
});
