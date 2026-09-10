import { unzip, strFromU8 } from 'fflate';
import { sanitizeCSS, sanitizeDocument } from './document';
import type { EpubBook } from './foliate-types';
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 350 * 1024 * 1024;

export async function loadEpub(fileUrl: string, signal: AbortSignal): Promise<EpubBook> {
  // Only the controlled same-origin file API may supply the archive.
  const url = new URL(fileUrl, location.href);
  if (url.origin !== location.origin) throw new Error('阅读器只能打开本地书库提供的文件。');
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('无法读取书籍文件，请重新打开书籍或检查本地服务。');
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw new Error('EPUB 超出阅读器 150 MB 文件限制。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error('EPUB 超出阅读器 150 MB 文件限制。');
  let expanded = 0, entries = 0;
  const archive = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let limitError: Error | undefined;
    const terminate = unzip(bytes, { filter(entry) {
      expanded += entry.originalSize; entries++;
      if (expanded > MAX_EXPANDED_BYTES || entries > 10000) {
        limitError = new Error('EPUB 解压内容超过阅读器限制，已停止加载。'); return false;
      }
      return !limitError;
    } }, (error, files) => limitError ? reject(limitError) : error ? reject(error) : resolve(files));
    signal.addEventListener('abort', () => { terminate(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!archive['META-INF/container.xml']) throw new Error('文件不是可读取的 EPUB：缺少 container.xml。');
  const textCache = new Map<string, string>();
  const text = (path: string) => {
    if (!archive[path]) return undefined;
    if (textCache.has(path)) return textCache.get(path)!;
    let value = strFromU8(archive[path]);
    if (/\.(?:xhtml|html|htm|svg)$/i.test(path) || /<(?:[a-z]+:)?(?:html|svg)(?:\s|>)/i.test(value)) value = sanitizeDocument(value, /\.svg$/i.test(path) || /<(?:[a-z]+:)?svg(?:\s|>)/i.test(value) && !/<(?:[a-z]+:)?html(?:\s|>)/i.test(value) ? 'image/svg+xml' : 'application/xhtml+xml');
    else if (/\.css$/i.test(path)) value = sanitizeCSS(value);
    textCache.set(path, value); return value;
  };
  const { EPUB } = await import('../../vendor/foliate-js/epub.js');
  const book = await new EPUB({ loadText: text, loadBlob: (path: string) => archive[path] ? new Blob([Uint8Array.from(archive[path]).buffer]) : undefined,
    getSize: (path: string) => archive[path]?.length ?? 0, sha1: undefined }).init() as unknown as EpubBook;
  if (!book.sections.length) { book.destroy(); throw new Error('这本 EPUB 没有可阅读的章节。'); }
  if (book.rendition?.layout === 'pre-paginated') { book.destroy(); throw new Error('首版支持可重排 EPUB。此书为固定版式，暂时无法打开。'); }
  book.transformTarget.addEventListener('load', (event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.isScript) detail.allow = false;
  });
  book.transformTarget.addEventListener('data', (event) => {
    const detail = (event as CustomEvent).detail;
    if (['application/xhtml+xml', 'text/html', 'image/svg+xml', 'text/css'].includes(detail.type)) {
      detail.data = Promise.resolve(detail.data).then(async (data: string | Blob) => {
        const value = typeof data === 'string' ? data : await data.text();
        return detail.type === 'text/css' ? sanitizeCSS(value, true) : sanitizeDocument(value, detail.type, true);
      });
    }
  });
  return book;
}
