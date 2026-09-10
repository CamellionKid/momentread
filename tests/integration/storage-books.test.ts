import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {zipSync, unzipSync, strToU8} from 'fflate';
import {createStore} from '../../server/storage/index';
import {createBookLibrary} from '../../server/books/index';
import {readArchive} from '../../server/books/archive';
import type {Store} from '../../shared/contracts/ports';

const open: Store[] = []; const dirs: string[] = [];
async function fixture() {const dir = await mkdtemp(join(tmpdir(), 'momentread-storage-int-')); dirs.push(dir); const store = createStore(dir); open.push(store); return {dir,store,library: createBookLibrary(store, dir)};}
function epub(options: {title?: string; script?: string; extra?: Record<string, Uint8Array>; opf?: string} = {}): Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'EPUB/package.opf': strToU8(options.opf ?? `<package><metadata><dc:title xmlns:dc="urn:test">${options.title ?? 'A synthetic book'}</dc:title><dc:creator xmlns:dc="urn:test">Test author</dc:creator><dc:language xmlns:dc="urn:test">en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`),
    'EPUB/one.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Synthetic text.</p>${options.script ?? ''}</body></html>`),
    ...options.extra,
  });
}
function metadataEpub(metadata: string, uniqueIdentifier = ''): Uint8Array {
  return epub({opf: `<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" unique-identifier="${uniqueIdentifier}"><metadata>${metadata}</metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`});
}
afterEach(async () => {for (const store of open.splice(0)) store.close(); for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true});});

describe('book import and backup', () => {
  it('copies actual EPUB bytes, reads metadata, and deduplicates by fingerprint', async () => {
    const {store, library} = await fixture(); const bytes = epub();
    const book = await library.importBook(bytes, 'synthetic.epub');
    expect(book).toMatchObject({title: 'A synthetic book',author: 'Test author',language: 'en'});
    const path = library.filePath(book.fileVersionId);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    expect((await library.importBook(bytes, 'renamed.epub')).id).toEqual(book.id);
    expect(store.list('books')).toHaveLength(1); expect(store.list('workspaces', book.id)).toHaveLength(1);
    expect(() => library.filePath('../../etc/passwd')).toThrow('找不到');
  });
  it('keeps changed EPUB content as a distinct file version identity', async () => {
    const {store, library} = await fixture(); const first = await library.importBook(epub(), 'book.epub'); const second = await library.importBook(epub({title: 'Revised'}), 'book.epub');
    expect(first.fileVersionId).not.toBe(second.fileVersionId); expect(store.list('files')).toHaveLength(2);
  });
  it('decodes standard XML metadata entities without permitting entity declarations', async () => {
    const {library} = await fixture();
    expect((await library.importBook(epub({title: 'Reason &amp; Reading'}), 'book.epub')).title).toBe('Reason & Reading');
  });
  it('reads an explicit EPUB 2 translator role, publication data and identifier', async () => {
    const {library} = await fixture();
    const bytes = metadataEpub('<dc:title>Metadata test</dc:title><dc:creator>Author</dc:creator><dc:contributor opf:role="trl">Translator</dc:contributor><dc:contributor opf:role="edt">Editor</dc:contributor><dc:publisher>Test Press</dc:publisher><dc:date opf:event="publication">2022-10-10</dc:date><dc:date opf:event="modification">2024-01-01</dc:date><meta name="edition" content="Second edition"/><dc:identifier>first-fallback</dc:identifier><dc:identifier id="primary">urn:uuid:publication-id</dc:identifier>', 'primary');
    expect(await library.importBook(bytes, 'metadata.epub')).toMatchObject({author: 'Author',translator: 'Translator',edition: 'Second edition · Test Press · 2022-10-10',identifier: 'urn:uuid:publication-id'});
  });
  it('resolves EPUB 3 translator and edition refinements without mistaking the book producer for a translator', async () => {
    const {library} = await fixture();
    const bytes = metadataEpub('<dc:title id="main">Metadata test</dc:title><dc:title id="edition">Third edition</dc:title><meta refines="#main" property="title-type">main</meta><meta refines="#edition" property="title-type">edition</meta><dc:creator id="author">Author</dc:creator><dc:contributor id="translator">Translator A</dc:contributor><dc:contributor id="translator2">Translator B</dc:contributor><dc:contributor id="producer">calibre</dc:contributor><meta refines="#translator" property="role" scheme="marc:relators">trl</meta><meta refines="#translator2" property="role">trl</meta><meta refines="#producer" property="role" scheme="marc:relators">bkp</meta><dc:identifier>first-fallback</dc:identifier><dc:identifier opf:scheme="ISBN">9780000000000</dc:identifier>');
    expect(await library.importBook(bytes, 'metadata.epub')).toMatchObject({title: 'Metadata test',author: 'Author',translator: 'Translator A、Translator B',edition: 'Third edition',identifier: '9780000000000'});
  });
  it('leaves unknown metadata empty instead of guessing a contributor or author role', async () => {
    const {library} = await fixture();
    const bytes = metadataEpub('<dc:title>Metadata test</dc:title><dc:creator>Author</dc:creator><dc:contributor>Unknown contributor</dc:contributor><dc:contributor id="producer">calibre</dc:contributor><meta refines="#producer" property="role" scheme="marc:relators">bkp</meta><meta property="dcterms:modified">2024-01-01</meta><meta name="generator" content="Test tool"/>');
    expect(await library.importBook(bytes, 'metadata.epub')).toMatchObject({translator: '',edition: '',identifier: ''});
  });
  it('backfills missing legacy fields while preserving edited metadata and file identity', async () => {
    const {library, store} = await fixture();
    const bytes = metadataEpub('<dc:title>Metadata test</dc:title><dc:contributor opf:role="trl">Translator</dc:contributor><dc:publisher>Test Press</dc:publisher><dc:identifier>identifier</dc:identifier>');
    const imported = await library.importBook(bytes, 'metadata.epub');
    const {translator: _translator,edition: _edition,identifier: _identifier,...legacy} = imported;
    store.put('books', legacy);
    expect(store.get('books', imported.id)?.translator).toBeUndefined();
    const backfilled = await library.importBook(bytes, 'renamed.epub');
    expect(backfilled).toMatchObject({id: imported.id,fileVersionId: imported.fileVersionId,translator: 'Translator',edition: 'Test Press',identifier: 'identifier'});
    store.put('books', {...backfilled,translator: '',edition: 'User correction',identifier: 'User identifier'});
    expect(await library.importBook(bytes, 'renamed.epub')).toMatchObject({translator: '',edition: 'User correction',identifier: 'User identifier'});
    expect(store.list('files')).toHaveLength(1);
  });
  it('imports UTF-8 originals without parsing them as markup', async () => {
    const {library} = await fixture(); const book = await library.importBook(epub(), 'book.epub');
    const file = await library.importOriginal(book.id, strToU8('Latin original fixture'), 'original.txt');
    expect(file.role).toBe('original'); expect((await readFile(library.filePath(file.id))).toString()).toBe('Latin original fixture');
    await expect(library.importOriginal(book.id, new Uint8Array([0xff]), 'wrong.txt')).rejects.toThrow('UTF-8');
    await expect(library.importOriginal(book.id, strToU8('PDF'), 'wrong.pdf')).rejects.toThrow('仅支持');
    await expect(library.importOriginal(randomUUID(), strToU8('text'), 'valid.txt')).rejects.toThrow('找不到');
  });
  it('rejects corrupt ZIPs, path traversal, encryption and XML entities', async () => {
    const {library, store} = await fixture();
    await expect(library.importBook(strToU8('not zip'), 'book.epub')).rejects.toThrow('压缩包');
    await expect(library.importBook(epub({extra: {'../escape.txt': strToU8('bad')}}), 'book.epub')).rejects.toThrow('路径');
    await expect(library.importBook(epub({extra: {'META-INF/encryption.xml': strToU8('<encryption/>')}}), 'book.epub')).rejects.toThrow('加密');
    await expect(library.importBook(epub({opf: '<!DOCTYPE foo SYSTEM "file:///etc/passwd"><package/>'}), 'book.epub')).rejects.toThrow('XML');
    expect(store.list('books')).toEqual([]);
  });
  it('stores scripted EPUB bytes inertly without executing or rewriting them', async () => {
    const {library} = await fixture();
    const bytes = epub({script: '<script>throw new Error("must never run during import")</script>'});
    const book = await library.importBook(bytes, 'scripted.epub');
    expect(await readFile(library.filePath(book.fileVersionId))).toEqual(Buffer.from(bytes));
  });
  it('checks inflation bounds before allocating compressed content', () => {
    const bytes = zipSync({'large.txt': strToU8('x'.repeat(2000))});
    expect(() => readArchive(bytes, {compressed: 10000,expanded: 100,entry: 100,count: 10})).toThrow('解压');
  });
  it('detects CRC corruption even when ZIP structure still parses', () => {
    const bytes = zipSync({'test.txt': [strToU8('123456'), {level: 0}]});
    bytes[30 + 'test.txt'.length] ^= 1;
    expect(() => readArchive(bytes)).toThrow('压缩包');
  });
  it('rejects compressed data whose actual expansion exceeds the declared bound', () => {
    const bytes = zipSync({'test.txt': strToU8('x'.repeat(10000))});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let p = 0; p < bytes.length - 28; p++) if (view.getUint32(p, true) === 0x02014b50) {view.setUint32(p + 24, 1, true); break;}
    expect(() => readArchive(bytes)).toThrow('压缩包');
  });
  it('rejects symlinked file paths even with valid stored IDs', async () => {
    const {dir, library} = await fixture(); const other = await fixture(); const book = await library.importBook(epub(), 'book.epub');
    const original = library.filePath(book.fileVersionId); await rm(original); await symlink(join(other.dir, 'momentread.sqlite'), original);
    expect(() => library.filePath(book.fileVersionId)).toThrow('路径');
    expect(dir).not.toBe(other.dir);
  });
  it('restores a consistent book, original, workspace and idempotent state into a fresh live store', async () => {
    const first = await fixture(); const book = await first.library.importBook(epub(), 'book.epub');
    await first.library.importOriginal(book.id, strToU8('Original'), 'original.txt');
    first.store.setIdempotent('saved', {id: book.id});
    const workspace = first.store.list('workspaces', book.id)[0]; first.store.put('workspaces', {...workspace,fontSize: 28});
    const backup = await first.library.backup(); const bytes = await readFile(backup.path);
    const archive = unzipSync(bytes); expect(Object.keys(archive).sort()).toEqual(['manifest.json','momentread.sqlite',...first.store.list('files').map(file => file.relativePath)].sort());
    const second = await fixture(); await second.library.restore(bytes);
    expect(second.store.get('books', book.id)).toEqual(book); expect(second.store.list('workspaces', book.id)[0].fontSize).toBe(28); expect(second.store.getIdempotent('saved')).toEqual({id: book.id});
    expect(await readFile(second.library.filePath(book.fileVersionId))).toEqual(await readFile(first.library.filePath(book.fileVersionId)));
    await expect(second.library.restore(bytes)).rejects.toThrow('空书库');
    second.store.close(); const reopened = createStore(second.dir); open.push(reopened); expect(reopened.get('books', book.id)).toEqual(book);
  });
  it('rejects a tampered backup without writing any records', async () => {
    const first = await fixture(); await first.library.importBook(epub(), 'book.epub'); const backup = await first.library.backup(); const archive = unzipSync(await readFile(backup.path));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])); archive[manifest.files[0].path] = strToU8('tampered');
    const second = await fixture(); await expect(second.library.restore(zipSync(archive))).rejects.toThrow('校验'); expect(second.store.list('books')).toEqual([]);
  });
});
