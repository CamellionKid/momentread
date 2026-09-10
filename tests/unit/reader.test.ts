// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { waitForChapter } from '../../src/reader/chapter-load';
import { sanitizeDocument, sanitizeCSS, BOOK_CSP, isPackagedResource } from '../../src/reader/document';
import { assertReferenceBook, progressFraction, rangeSegment } from '../../src/reader/references';
import * as CFI from '../../vendor/foliate-js/epubcfi.js';
import type { Book, TextReference } from '../../shared/contracts';

const makeDoc = () => new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>相同句子。</p><p>这是第二段。相同句子。</p><p>第三段结尾。</p></body></html>', 'application/xhtml+xml');
const book: Book = { id: 'book-a', fileVersionId: 'file-a', title: 'Synthetic test', author: '', language: 'zh', createdAt: new Date().toISOString() };

describe('EPUB references', () => {
  it('preserves the full range across paragraphs and bounded surrounding context', () => {
    const doc = makeDoc(), paragraphs = doc.querySelectorAll('p');
    const range = doc.createRange(); range.setStart(paragraphs[0].firstChild!, 2); range.setEnd(paragraphs[2].firstChild!, 3);
    const segment = rangeSegment(range, { spineId: 'chapter.xhtml', chapter: 'Chapter', baseCFI: 'epubcfi(/6/2[c1])' });
    expect(segment.exact).toBe('句子。这是第二段。相同句子。第三段');
    expect(segment.prefix).toBe('相同'); expect(segment.suffix).toBe('结尾。');
    const parsed = CFI.parse(segment.cfi); parsed.parent.shift();
    expect(CFI.toRange(doc, parsed).toString()).toBe(segment.exact);
  });
  it('normalizes element-boundary selections so CFI preserves both paragraph endpoints', () => {
    const doc = makeDoc(), paragraphs = doc.querySelectorAll('p');
    const range = doc.createRange(); range.setStartBefore(paragraphs[1]); range.setEndAfter(paragraphs[2]);
    const segment = rangeSegment(range, { spineId: 'chapter.xhtml', chapter: 'Chapter', baseCFI: 'epubcfi(/6/2[c1])' });
    const parsed = CFI.parse(segment.cfi); parsed.parent.shift();
    expect(CFI.toRange(doc, parsed).toString()).toBe(range.toString());
    expect(CFI.toRange(doc, parsed).startContainer.parentElement).toBe(paragraphs[1]);
  });
  it('locates the second identical phrase by structural CFI after typography changes', () => {
    const doc = makeDoc(), node = doc.querySelectorAll('p')[1].firstChild!;
    const range = doc.createRange(); range.setStart(node, 6); range.setEnd(node, 11);
    const segment = rangeSegment(range, { spineId: 'chapter.xhtml', chapter: 'Chapter', baseCFI: 'epubcfi(/6/2[c1])' });
    doc.body.style.fontSize = '30px';
    const parsed = CFI.parse(segment.cfi); parsed.parent.shift();
    const restored = CFI.toRange(doc, parsed);
    expect(restored.startContainer).toBe(node); expect(restored.toString()).toBe('相同句子。');
  });
  it('rejects empty and non-body ranges', () => {
    const doc = makeDoc(), range = doc.createRange(); range.selectNodeContents(doc.head);
    expect(() => rangeSegment(range, { spineId: '', chapter: '', baseCFI: '' })).toThrow('同一章节');
    range.selectNodeContents(doc.body); range.collapse();
    expect(() => rangeSegment(range, { spineId: '', chapter: '', baseCFI: '' })).toThrow('选取正文');
  });
  it('refuses cross-book and changed-file references', () => {
    const reference = { bookId: 'book-b', fileVersionId: 'file-a', segments: [] } as TextReference;
    expect(() => assertReferenceBook(reference, book)).toThrow('另一本书');
    reference.bookId = book.id; reference.fileVersionId = 'file-b';
    expect(() => assertReferenceBook(reference, book)).toThrow('文件版本');
    reference.fileVersionId = book.fileVersionId;
    expect(() => assertReferenceBook(reference, book)).toThrow('没有');
  });
  it('uses stable file-size weights instead of screen page numbers', () => {
    expect(progressFraction([100, 300], 1, .5)).toBe(.625);
    expect(progressFraction([100, 300], 1, NaN)).toBe(.25);
    expect(progressFraction([0, 0], 0, .5)).toBe(0);
    expect(progressFraction([100], 0, 2)).toBe(1);
  });
});

describe('EPUB isolation', () => {
  it('removes executable content and remote resources while keeping text and packaged images', () => {
    const source = '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="refresh" content="0;url=https://evil.test"/><script src="evil.js">alert(1)</script><link rel="stylesheet" href="https://evil.test/a.css"/></head><body onload="alert(1)"><p>Safe text</p><img src="../images/a.png"/><img src="https://evil.test/pixel"/><iframe src="https://evil.test"/><form action="/api"><input/></form><a href="javascript:alert(1)">bad</a><svg xmlns="http://www.w3.org/2000/svg"><animate href="#x"/></svg></body></html>';
    const doc = new DOMParser().parseFromString(sanitizeDocument(source), 'application/xhtml+xml');
    expect(doc.querySelector('script,iframe,form,input,animate')).toBeNull();
    expect(doc.body.hasAttribute('onload')).toBe(false);
    expect(doc.querySelector('p')?.textContent).toBe('Safe text');
    expect(doc.querySelectorAll('img')[0].getAttribute('src')).toBe('../images/a.png');
    expect(doc.querySelectorAll('img')[1].hasAttribute('src')).toBe(false);
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('meta')?.getAttribute('content')).toBe(BOOK_CSP);
    expect(doc.querySelectorAll('meta')).toHaveLength(1);
  });
  it('blocks remote and obfuscated CSS imports and URLs', () => {
    const css = sanitizeCSS('@import "https://evil.test/a.css"; a{background:url(https://evil.test/a);src:url(../font.woff);color:white} b{background:url(\\68ttps://evil.test/a)}');
    expect(css).not.toContain('evil.test'); expect(css).toContain('../font.woff'); expect(css).toContain('color:white');
    expect(isPackagedResource('//evil.test/a')).toBe(false);
    expect(isPackagedResource('data:image/svg+xml;base64,AAA')).toBe(false);
    expect(isPackagedResource('blob:http://localhost/test')).toBe(false);
    expect(isPackagedResource('blob:http://localhost/test', true)).toBe(true);
  });
  it('also strips active SVG elements and xlink remote references', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><script>bad()</script><image xlink:href="https://evil.test/a"/><foreignObject><iframe/></foreignObject><text>Hello</text></svg>';
    const doc = new DOMParser().parseFromString(sanitizeDocument(source, 'image/svg+xml'), 'image/svg+xml');
    expect(doc.querySelector('script,foreignObject')).toBeNull();
    expect(doc.querySelector('image')?.attributes.length).toBe(0);
    expect(doc.querySelector('text')?.textContent).toBe('Hello');
  });
});


describe('chapter loading failure recovery', () => {
  it('turns missing load completion into a recoverable error and cleans up the timer', async () => {
    vi.useFakeTimers();
    try {
      const result = waitForChapter(new Promise<void>(() => {}), 15000);
      const assertion = expect(result).rejects.toThrow('Chrome');
      await vi.advanceTimersByTimeAsync(15000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('preserves completion and original errors without leaving timers', async () => {
    vi.useFakeTimers();
    try {
      await expect(waitForChapter(Promise.resolve('loaded'))).resolves.toBe('loaded');
      await expect(waitForChapter(Promise.reject(new Error('Bad chapter')))).rejects.toThrow('Bad chapter');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
