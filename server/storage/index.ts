import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {AppError, EventSchema, entitySchemas, type EntityMap, type RunEvent} from '../../shared/contracts/index';
import type {Store} from '../../shared/contracts/ports';

type Kind = keyof EntityMap;
type Row = {kind: Kind; id: string; bookId: string; data: string};
export interface StoreSnapshot {
  entities: Row[];
  events: RunEvent[];
  idempotency: Array<{key: string; value: string}>;
}
const databases = new WeakMap<Store, Database.Database>();
const schema = `
  CREATE TABLE IF NOT EXISTS entities (
    kind TEXT NOT NULL, id TEXT NOT NULL, bookId TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind, id)
  );
  CREATE INDEX IF NOT EXISTS entities_kind_book ON entities(kind, bookId);
  CREATE TABLE IF NOT EXISTS run_events (
    runId TEXT NOT NULL, seq INTEGER NOT NULL, bookId TEXT NOT NULL,
    discussionId TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    PRIMARY KEY(runId, seq)
  );
  CREATE INDEX IF NOT EXISTS run_events_book ON run_events(bookId);
  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK(json_valid(value))
  );
  PRAGMA user_version = 1;
`;

function serialize(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new AppError('INVALID_DATA', '无法保存未定义的数据。');
  return result;
}

export function createStore(dataDir: string): Store {
  mkdirSync(resolve(dataDir), {recursive: true, mode: 0o700});
  const db = new Database(resolve(dataDir, 'momentread.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');
  const version = db.pragma('user_version', {simple: true}) as number;
  if (version > 1) {
    db.close();
    throw new AppError('DATABASE_VERSION', '此书库由更新版本创建，请升级 MomentRead。', 409);
  }
  db.transaction(() => db.exec(schema))();
  const get = db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?');
  const list = db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid');
  const listBook = db.prepare('SELECT data FROM entities WHERE kind = ? AND bookId = ? ORDER BY rowid');
  const put = db.prepare('INSERT INTO entities(kind,id,bookId,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET bookId=excluded.bookId,data=excluded.data');
  const store: Store = {
    get<K extends Kind>(kind: K, id: string): EntityMap[K] | undefined {
      const row = get.get(kind, id) as {data: string} | undefined;
      return row ? entitySchemas[kind].parse(JSON.parse(row.data)) as EntityMap[K] : undefined;
    },
    list<K extends Kind>(kind: K, bookId?: string): EntityMap[K][] {
      const rows = (bookId === undefined ? list.all(kind) : listBook.all(kind, bookId)) as Array<{data: string}>;
      return rows.map(row => entitySchemas[kind].parse(JSON.parse(row.data)) as EntityMap[K]);
    },
    put<K extends Kind>(kind: K, value: EntityMap[K]) {
      const parsed = entitySchemas[kind].parse(value) as EntityMap[K];
      const previous = store.get(kind, parsed.id);
      if (previous && (kind === 'files' || (kind === 'summaries' && (previous as EntityMap['summaries']).confirmed)) && serialize(previous) !== serialize(parsed)) {
        throw new AppError('IMMUTABLE_VERSION', '已保存的文件版本和已确认的小结不能被覆盖。', 409);
      }
      if (previous && 'bookId' in previous && 'bookId' in parsed && previous.bookId !== parsed.bookId) {
        throw new AppError('BOOK_MISMATCH', '已保存的记录不能移动到另一书籍。', 409);
      }
      put.run(kind, parsed.id, kind === 'books' ? parsed.id : (parsed as {bookId: string}).bookId, serialize(parsed));
    },
    remove(kind, id) {
      if (kind === 'files' || (kind === 'summaries' && store.get('summaries', id)?.confirmed)) {
        throw new AppError('IMMUTABLE_VERSION', '不能删除不可变版本。', 409);
      }
      db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run(kind, id);
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(() => {
        const result = fn();
        if (result && typeof (result as {then?: unknown}).then === 'function') throw new AppError('ASYNC_TRANSACTION', '事务内不能执行异步操作。', 500);
        return result;
      })();
    },
    appendEvent(event) {
      const value = EventSchema.parse(event);
      const previous = db.prepare('SELECT data FROM run_events WHERE runId = ? AND seq = ?').get(value.runId, value.seq) as {data: string} | undefined;
      if (previous) {
        if (previous.data === serialize(value)) return;
        throw new AppError('EVENT_CONFLICT', '运行事件序号已存在。', 409);
      }
      const ownership = db.prepare('SELECT bookId,discussionId FROM run_events WHERE runId = ? LIMIT 1').get(value.runId) as {bookId: string; discussionId: string} | undefined;
      if (ownership && (ownership.bookId !== value.bookId || ownership.discussionId !== value.discussionId)) throw new AppError('EVENT_OWNER_CONFLICT', '运行事件归属不一致。', 409);
      db.prepare('INSERT INTO run_events(runId,seq,bookId,discussionId,data) VALUES(?,?,?,?,?)').run(value.runId, value.seq, value.bookId, value.discussionId, serialize(value));
    },
    events(runId, after = -1) {
      return (db.prepare('SELECT data FROM run_events WHERE runId = ? AND seq > ? ORDER BY seq').all(runId, after) as Array<{data: string}>).map(row => EventSchema.parse(JSON.parse(row.data)));
    },
    getIdempotent(key) {
      const row = db.prepare('SELECT value FROM idempotency WHERE key = ?').get(key) as {value: string} | undefined;
      return row ? JSON.parse(row.value) : undefined;
    },
    setIdempotent(key, value) {
      const serialized = serialize(value);
      const previous = db.prepare('SELECT value FROM idempotency WHERE key = ?').get(key) as {value: string} | undefined;
      if (previous && previous.value !== serialized) throw new AppError('IDEMPOTENCY_CONFLICT', '此请求标识已经用于其他结果。', 409);
      db.prepare('INSERT OR IGNORE INTO idempotency(key,value) VALUES(?,?)').run(key, serialized);
    },
    setPreference(key, value) {
      db.prepare('INSERT INTO idempotency(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialize(value));
    },
    close() { if (db.open) db.close(); },
  };
  databases.set(store, db);
  return store;
}

/** SQLite serializes a consistent snapshot, including committed WAL contents. */
export function serializeStore(store: Store): Buffer {
  const db = databases.get(store);
  if (!db) throw new AppError('INVALID_STORE', '无法备份此存储。', 500);
  const bytes = db.serialize();
  // sqlite3_deserialize cannot open WAL images. SQLite documents normalizing
  // these format bytes on the complete serialized snapshot (not the live DB).
  // https://www.sqlite.org/c3ref/deserialize.html
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

/** Read a backup as data only. Never execute its schema or replace the live DB. */
export function readStoreSnapshot(bytes: Uint8Array): StoreSnapshot {
  let db: Database.Database | undefined;
  try {
    db = new Database(Buffer.from(bytes), {readonly: true});
    db.pragma('trusted_schema = OFF');
    if (db.pragma('user_version', {simple: true}) !== 1 || db.pragma('quick_check', {simple: true}) !== 'ok') throw new Error('Unsupported or invalid database');
    const actual = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{name: string; type: string}>;
    const expected: Record<string, string> = {entities: 'table', entities_kind_book: 'index', run_events: 'table', run_events_book: 'index', idempotency: 'table'};
    if (actual.length !== Object.keys(expected).length || actual.some(row => expected[row.name] !== row.type)) throw new Error('Unexpected schema');
    const entities = db.prepare('SELECT kind,id,bookId,data FROM entities ORDER BY rowid').all() as Row[];
    for (const row of entities) {
      if (!Object.hasOwn(entitySchemas, row.kind)) throw new Error('Unknown entity');
      const value = entitySchemas[row.kind].parse(JSON.parse(row.data));
      if (row.id !== value.id || row.bookId !== ('bookId' in value ? value.bookId : value.id)) throw new Error('Entity index mismatch');
      row.data = serialize(value);
    }
    const events = (db.prepare('SELECT runId,seq,bookId,discussionId,data FROM run_events ORDER BY runId,seq').all() as Array<{runId: string; seq: number; bookId: string; discussionId: string; data: string}>).map(row => {
      const value = EventSchema.parse(JSON.parse(row.data));
      if (row.runId !== value.runId || row.seq !== value.seq || row.bookId !== value.bookId || row.discussionId !== value.discussionId) throw new Error('Event index mismatch');
      return value;
    });
    const idempotency = db.prepare('SELECT key,value FROM idempotency').all() as Array<{key: string; value: string}>;
    for (const row of idempotency) { if (typeof row.key !== 'string') throw new Error('Invalid key'); JSON.parse(row.value); }
    return {entities, events, idempotency};
  } catch {
    throw new AppError('INVALID_BACKUP_DATABASE', '备份数据库无效或版本不受支持。');
  } finally { db?.close(); }
}

export function restoreStoreSnapshot(store: Store, snapshot: StoreSnapshot): void {
  store.transaction(() => {
    if ((Object.keys(entitySchemas) as Kind[]).some(kind => store.list(kind).length)) throw new AppError('RESTORE_NOT_EMPTY', '恢复仅允许用于空书库，请先使用新的数据目录。', 409);
    for (const row of snapshot.entities) store.put(row.kind, JSON.parse(row.data));
    for (const event of snapshot.events) store.appendEvent(event);
    for (const row of snapshot.idempotency) store.setIdempotent(row.key, JSON.parse(row.value));
  });
}
