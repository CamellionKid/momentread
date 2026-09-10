import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, realpathSync, statSync} from 'node:fs';
import {readFile, writeFile, rename, rm, mkdir, link} from 'node:fs/promises';
import {basename, extname, posix, resolve, sep} from 'node:path';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {zipSync, strToU8} from 'fflate';
import {z} from 'zod';
import {AppError, FileVersionSchema, entitySchemas, now, type Book, type FileVersion} from '../../shared/contracts/index';
import type {BookLibrary, Store} from '../../shared/contracts/ports';
import {readStoreSnapshot, restoreStoreSnapshot, serializeStore} from '../storage/index';
import {assertArchivePath, BACKUP_LIMITS, readArchive} from './archive';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: true});
function xml(bytes: Uint8Array): any {
  const text = decode(bytes);
  if (/<!ENTITY\b|<!DOCTYPE\s+[^>]+(?:SYSTEM|PUBLIC)/i.test(text) || XMLValidator.validate(text) !== true) throw new AppError('INVALID_EPUB', 'EPUB 元数据不是可安全读取的 XML。');
  return parser.parse(text);
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('、');
  if (typeof value === 'object' && value !== null && '#text' in value) return text((value as {'#text': unknown})['#text']);
  return typeof value === 'string' ? value : '';
}
const distinct = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
type ParsedMetadata = {title: string; author: string; language: string; translator: string; edition: string; identifier: string};
function publicationMetadata(publication: any): ParsedMetadata {
  const metadata = publication?.metadata;
  const refinements = array<any>(metadata?.meta);
  const titles = array<any>(metadata?.title);
  const refinedValues = (item: any, property: string): string[] => {
    const id = item?.['@_id'];
    if (typeof id !== 'string') return [];
    return refinements.filter(meta => meta?.['@_refines'] === `#${id}` && meta?.['@_property'] === property).map(text);
  };
  const editionTitles = titles.filter(title => refinedValues(title, 'title-type').includes('edition'));
  const mainTitles = titles.filter(title => refinedValues(title, 'title-type').includes('main'));
  const title = text(mainTitles.length ? mainTitles : titles.filter(title => !editionTitles.includes(title)));
  const translators = array<any>(metadata?.contributor).filter(contributor => {
    if (contributor?.['@_role'] === 'trl') return true;
    const id = contributor?.['@_id'];
    return typeof id === 'string' && refinements.some(meta =>
      meta?.['@_refines'] === `#${id}` && meta?.['@_property'] === 'role' && text(meta) === 'trl' &&
      (!meta?.['@_scheme'] || meta['@_scheme'] === 'marc:relators'));
  });
  const editionNames = new Set(['edition', 'bookEdition', 'schema:bookEdition', 'prism:edition', 'calibre:edition']);
  const explicitEditions = refinements.filter(meta => !meta?.['@_refines'] &&
    (editionNames.has(meta?.['@_property']) || editionNames.has(meta?.['@_name'])))
    .map(meta => text(meta) || text(meta?.['@_content']));
  const publicationDates = array<any>(metadata?.date).filter(date => !date?.['@_event'] || date['@_event'] === 'publication').map(text);
  const issuedDates = refinements.filter(meta => !meta?.['@_refines'] && meta?.['@_property'] === 'dcterms:issued').map(text);
  const edition = distinct([...editionTitles.map(text), ...explicitEditions, ...array(metadata?.publisher).map(text), ...publicationDates, ...issuedDates]).join(' · ');
  const identifiers = array<any>(metadata?.identifier).filter(identifier => text(identifier).trim());
  const uniqueId = publication?.['@_unique-identifier'];
  const identifier = text(identifiers.find(item => typeof uniqueId === 'string' && item?.['@_id'] === uniqueId) ??
    identifiers.find(item => item?.['@_scheme']?.toLowerCase() === 'isbn' || /^urn:isbn:/i.test(text(item))) ?? identifiers[0]);
  return {title,author: text(metadata?.creator),language: text(metadata?.language) || 'und',translator: distinct(translators.map(text)).join('、'),edition,identifier};
}
function epubMetadata(bytes: Uint8Array): ParsedMetadata {
  const archive = readArchive(bytes);
  if (archive.has('META-INF/encryption.xml')) throw new AppError('ENCRYPTED_EPUB', '此 EPUB 包含加密资源，当前不支持导入。');
  if (archive.has('mimetype') && decode(archive.get('mimetype')!).trim() !== 'application/epub+zip') throw new AppError('INVALID_EPUB', '文件的 EPUB 类型声明无效。');
  const container = archive.get('META-INF/container.xml');
  if (!container) throw new AppError('INVALID_EPUB', 'EPUB 缺少出版物入口。');
  const roots = array<any>(xml(container)?.container?.rootfiles?.rootfile);
  const root = roots.find(item => item['@_media-type'] === 'application/oebps-package+xml') ?? roots[0];
  const opfPath = root?.['@_full-path'];
  if (typeof opfPath !== 'string') throw new AppError('INVALID_EPUB', 'EPUB 缺少内容清单。');
  assertArchivePath(opfPath);
  const opf = archive.get(opfPath);
  if (!opf) throw new AppError('INVALID_EPUB', '找不到 EPUB 内容清单。');
  const publication = xml(opf)?.package;
  const items = array<any>(publication?.manifest?.item);
  const spine = array<any>(publication?.spine?.itemref);
  if (!items.length || !spine.length) throw new AppError('INVALID_EPUB', 'EPUB 没有可阅读的章节。');
  for (const item of items) {
    if (typeof item['@_href'] !== 'string') throw new AppError('INVALID_EPUB', 'EPUB 资源缺少地址。');
    const href = item['@_href'].split('#')[0];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) throw new AppError('EXTERNAL_EPUB_RESOURCE', '当前仅支持资源包含在文件内的 EPUB。');
    let decoded: string;
    try { decoded = decodeURIComponent(href); } catch { throw new AppError('INVALID_EPUB', 'EPUB 资源地址无效。'); }
    const resourcePath = posix.normalize(posix.join(posix.dirname(opfPath), decoded));
    assertArchivePath(resourcePath);
    if (!archive.has(resourcePath)) throw new AppError('INVALID_EPUB', 'EPUB 清单中的资源缺失。');
  }
  if (spine.some(item => !items.some(resource => resource['@_id'] === item['@_idref']))) throw new AppError('INVALID_EPUB', 'EPUB 章节引用无效。');
  // This layer stores the exact ZIP as inert binary data. It never evaluates
  // publication HTML or JavaScript. Reader sanitization + sandbox + CSP are
  // mandatory before rendering; removing scripts here would change file IDs.
  const metadata = publicationMetadata(publication);
  if (!metadata.title.trim()) throw new AppError('INVALID_EPUB', 'EPUB 缺少书名元数据。');
  return metadata;
}
const Manifest = z.object({format: z.literal('momentread-backup'),version: z.literal(1),createdAt: z.string().datetime(),database: z.object({path: z.literal('momentread.sqlite'),sha256: z.string().regex(/^[a-f0-9]{64}$/)}),files: z.array(z.object({id: z.string().uuid(),path: z.string(),sha256: z.string().regex(/^[a-f0-9]{64}$/),size: z.number().int().nonnegative()}))});

export function createBookLibrary(store: Store, dataDir: string): BookLibrary {
  const base = resolve(dataDir);
  mkdirSync(base, {recursive: true, mode: 0o700});
  const realBase = realpathSync(base);
  for (const folder of ['files', 'backups', 'staging']) {
    mkdirSync(resolve(base, folder), {recursive: true, mode: 0o700});
    const real = realpathSync(resolve(base, folder));
    if (!real.startsWith(realBase + sep)) throw new AppError('UNSAFE_DATA_DIRECTORY', '数据目录包含不安全的链接。', 500);
  }
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }
  function validateFilename(filename: string): string {
    const safe = basename(filename.replaceAll('\\', '/'));
    if (!safe || safe.length > 255 || /[\x00-\x1f\x7f]/.test(safe)) throw new AppError('INVALID_FILENAME', '文件名无效。');
    return safe;
  }
  function controlledPath(file: FileVersion): string {
    if (!new RegExp(`^files/${file.id}\\.(epub|txt)$`).test(file.relativePath)) throw new AppError('INVALID_FILE_PATH', '书籍文件记录无效。', 409);
    const path = resolve(base, file.relativePath);
    let real: string;
    try { real = realpathSync(path); } catch { throw new AppError('FILE_MISSING', '书籍文件已丢失，请从备份恢复。', 404); }
    if (!real.startsWith(realBase + sep) || !statSync(real).isFile()) throw new AppError('INVALID_FILE_PATH', '书籍文件路径无效。', 409);
    return real;
  }
  async function writeVersion(bytes: Uint8Array, filename: string, bookId: string, role: 'book' | 'original'): Promise<FileVersion> {
    const id = randomUUID();
    const extension = extname(filename).toLowerCase();
    const file: FileVersion = {id,bookId,filename,mediaType: extension === '.epub' ? 'application/epub+zip' : 'text/plain',sha256: hash(bytes),relativePath: `files/${id}${extension}`,size: bytes.byteLength,role,createdAt: now()};
    const temp = resolve(base, 'staging', `${id}.part`);
    const destination = resolve(base, file.relativePath);
    try { await writeFile(temp, bytes, {flag: 'wx', mode: 0o600}); await rename(temp, destination); }
    catch { await rm(temp, {force: true}); throw new AppError('FILE_WRITE_FAILED', '无法保存书籍文件，请检查磁盘空间。', 500, true); }
    return file;
  }
  const library: BookLibrary = {
    importBook(bytes, filename) { return serial(async () => {
      const safe = validateFilename(filename);
      if (extname(safe).toLowerCase() !== '.epub') throw new AppError('UNSUPPORTED_FORMAT', '请选择 EPUB 文件。');
      const metadata = epubMetadata(bytes);
      const fingerprint = hash(bytes);
      const existing = store.list('files').find(file => file.role === 'book' && file.sha256 === fingerprint);
      if (existing) {
        const book = store.get('books', existing.bookId);
        if (book) {
          controlledPath(existing);
          // Backfill legacy records only. Explicit edits, including an empty
          // field, are preserved when the same immutable file is reimported.
          const enriched: Book = {...book,translator: book.translator ?? metadata.translator,edition: book.edition ?? metadata.edition,identifier: book.identifier ?? metadata.identifier};
          store.put('books', enriched);
          return enriched;
        }
      }
      const id = randomUUID();
      const file = await writeVersion(bytes, safe, id, 'book');
      const book: Book = {id,...metadata,fileVersionId: file.id,createdAt: now()};
      try { store.transaction(() => {
        store.put('books', book); store.put('files', file);
        store.put('workspaces', {id: randomUUID(),bookId: id,position: null,activeDiscussionId: null,collapsed: [],fontSize: 24,updatedAt: now()});
      }); } catch (error) { await rm(resolve(base, file.relativePath), {force: true}); throw error; }
      return book;
    }); },
    importOriginal(bookId, bytes, filename) { return serial(async () => {
      if (!store.get('books', bookId)) throw new AppError('BOOK_NOT_FOUND', '找不到这本书。', 404);
      const safe = validateFilename(filename);
      const extension = extname(safe).toLowerCase();
      if (!['.epub', '.txt'].includes(extension)) throw new AppError('UNSUPPORTED_FORMAT', '原著仅支持 EPUB 或 UTF-8 TXT。');
      if (extension === '.epub') epubMetadata(bytes);
      else {
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new AppError('ORIGINAL_TOO_LARGE', 'TXT 原著必须为非空文件且不超过 20 MB。', 413);
        try { if (decode(bytes).includes('\0')) throw new Error('Binary text'); } catch { throw new AppError('INVALID_TEXT', 'TXT 原著必须使用 UTF-8 编码。'); }
      }
      const fingerprint = hash(bytes);
      const existing = store.list('files', bookId).find(file => file.role === 'original' && file.sha256 === fingerprint);
      if (existing) { controlledPath(existing); return existing; }
      const file = await writeVersion(bytes, safe, bookId, 'original');
      try { store.put('files', file); } catch (error) { await rm(resolve(base, file.relativePath), {force: true}); throw error; }
      return file;
    }); },
    filePath(fileId) {
      const file = store.get('files', fileId);
      if (!file) throw new AppError('FILE_NOT_FOUND', '找不到此文件。', 404);
      return controlledPath(file);
    },
    backup() { return serial(async () => {
      const id = randomUUID();
      const database = serializeStore(store);
      const snapshot = readStoreSnapshot(database);
      const files = snapshot.entities.filter(row => row.kind === 'files').map(row => FileVersionSchema.parse(JSON.parse(row.data)));
      if (database.length > BACKUP_LIMITS.entry || files.length + 2 > BACKUP_LIMITS.count) throw new AppError('BACKUP_TOO_LARGE', '书库超过当前备份大小限制。', 413);
      const payload: Record<string, Uint8Array> = Object.create(null);
      payload['momentread.sqlite'] = database;
      const entries: z.infer<typeof Manifest>['files'] = [];
      let total = database.length;
      for (const file of files) {
        const bytes = await readFile(controlledPath(file));
        if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new AppError('FILE_INTEGRITY', '书籍文件校验失败，备份已停止。', 409);
        total += bytes.length;
        if (total > BACKUP_LIMITS.expanded) throw new AppError('BACKUP_TOO_LARGE', '书库超过当前备份大小限制。', 413);
        payload[file.relativePath] = bytes;
        entries.push({id: file.id,path: file.relativePath,sha256: file.sha256,size: file.size});
      }
      payload['manifest.json'] = strToU8(JSON.stringify({format: 'momentread-backup',version: 1,createdAt: now(),database: {path: 'momentread.sqlite',sha256: hash(database)},files: entries}));
      const zip = zipSync(payload, {level: 1});
      if (zip.length > BACKUP_LIMITS.compressed) throw new AppError('BACKUP_TOO_LARGE', '备份超过当前大小限制。', 413);
      const path = resolve(base, 'backups', `${id}.zip`);
      await writeFile(path, zip, {flag: 'wx', mode: 0o600});
      return {id, path};
    }); },
    restore(bytes) { return serial(async () => {
      if ((Object.keys(entitySchemas) as Array<keyof typeof entitySchemas>).some(kind => store.list(kind).length)) throw new AppError('RESTORE_NOT_EMPTY', '恢复仅允许用于空书库，请先使用新的数据目录。', 409);
      const archive = readArchive(bytes, BACKUP_LIMITS);
      let manifest: z.infer<typeof Manifest>;
      try { manifest = Manifest.parse(JSON.parse(decode(archive.get('manifest.json')!))); } catch { throw new AppError('INVALID_BACKUP', '备份清单无效。'); }
      const database = archive.get(manifest.database.path);
      if (!database || hash(database) !== manifest.database.sha256) throw new AppError('INVALID_BACKUP', '备份数据库校验失败。');
      const snapshot = readStoreSnapshot(database);
      const fileRecords = snapshot.entities.filter(row => row.kind === 'files').map(row => FileVersionSchema.parse(JSON.parse(row.data)));
      const bookIds = new Set(snapshot.entities.filter(row => row.kind === 'books').map(row => row.id));
      if (manifest.files.length !== fileRecords.length || archive.size !== manifest.files.length + 2 || new Set(manifest.files.map(file => file.id)).size !== manifest.files.length || snapshot.entities.some(row => !bookIds.has(row.bookId))) throw new AppError('INVALID_BACKUP', '备份记录关系或文件数量不一致。');
      for (const file of fileRecords) {
        const entry = manifest.files.find(item => item.id === file.id);
        const content = archive.get(file.relativePath);
        if (!new RegExp(`^files/${file.id}\\.(epub|txt)$`).test(file.relativePath) || !entry || entry.path !== file.relativePath || entry.sha256 !== file.sha256 || entry.size !== file.size || !content || content.length !== file.size || hash(content) !== file.sha256) throw new AppError('INVALID_BACKUP', '备份书籍文件校验失败。');
      }
      for (const row of snapshot.entities.filter(row => row.kind === 'books')) {
        const book = JSON.parse(row.data) as Book;
        if (!fileRecords.some(file => file.id === book.fileVersionId && file.bookId === book.id && file.role === 'book')) throw new AppError('INVALID_BACKUP', '备份缺少对应的书籍版本。');
      }
      const stage = resolve(base, 'staging', randomUUID());
      await mkdir(stage, {mode: 0o700});
      const moved: string[] = [];
      try {
        for (const file of fileRecords) {
          const temp = resolve(stage, file.id);
          await writeFile(temp, archive.get(file.relativePath)!, {flag: 'wx', mode: 0o600});
        }
        for (const file of fileRecords) {
          const destination = resolve(base, file.relativePath);
          try {
            // Atomic, non-overwriting publication of a fully staged file.
            await link(resolve(stage, file.id), destination);
            moved.push(destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // An interrupted previous restore may have published the same
            // immutable file before its DB transaction. Reuse only exact bytes.
            const existing = await readFile(controlledPath(file));
            if (existing.length !== file.size || hash(existing) !== file.sha256) throw new AppError('RESTORE_FILE_CONFLICT', '恢复位置存在不匹配的文件，未覆盖原文件。', 409);
          }
        }
        restoreStoreSnapshot(store, snapshot);
      } catch (error) {
        for (const path of moved) await rm(path, {force: true});
        if (error instanceof AppError) throw error;
        throw new AppError('RESTORE_FAILED', '恢复未完成，原有数据未被覆盖。', 500, true);
      } finally { await rm(stage, {recursive: true, force: true}); }
    }); },
  };
  return library;
}
