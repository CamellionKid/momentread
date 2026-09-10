// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { loadEpub } from '../../src/reader/load-book';
import { rangeSegment } from '../../src/reader/references';

const syntheticArchive = () => zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/package.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">reader-fixture</dc:identifier><dc:title>Reader fixture</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'),
  'OEBPS/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>'),
  'OEBPS/one.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title><script>throw new Error("never run")</script></head><body><p>第一段，包含重复句。</p><p>第二段，包含重复句。</p><img src="https://unwanted.test/track"/></body></html>'),
  'OEBPS/two.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>二</title></head><body><p>第二章的独立位置。</p></body></html>'),
});
const provide = (bytes: Uint8Array) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => Uint8Array.from(bytes).buffer })));
afterEach(() => vi.unstubAllGlobals());

describe('actual EPUB parsing through foliate', () => {
  it('loads an archive, actual navigation metadata, and stable cross-paragraph references', async () => {
    provide(syntheticArchive());
    const epub = await loadEpub('/api/files/test', new AbortController().signal);
    try {
      expect(epub.sections).toHaveLength(2); expect(epub.toc?.map(item => item.label)).toEqual(['第一章', '第二章']);
      const doc = await epub.sections[0].createDocument();
      expect(doc.querySelector('script')).toBeNull(); expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
      const nodes = doc.querySelectorAll('p');
      const range = doc.createRange(); range.setStart(nodes[0].firstChild!, 3); range.setEnd(nodes[1].firstChild!, 8);
      const segment = rangeSegment(range, { spineId: epub.sections[0].id, chapter: '第一章', baseCFI: epub.sections[0].cfi });
      const location = epub.resolveCFI(segment.cfi);
      expect(location.index).toBe(0);
      const freshDocument = await epub.sections[0].createDocument();
      expect(typeof location.anchor === 'function' && location.anchor(freshDocument)?.toString()).toBe(segment.exact);
      expect(epub.resolveHref('OEBPS/two.xhtml')?.index).toBe(1);
    } finally { epub.destroy(); }
  });

  it('rejects remote archive URLs before making any request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadEpub('https://external.test/book.epub', new AbortController().signal)).rejects.toThrow('本地书库');
    expect(fetcher).not.toHaveBeenCalled();
  });

  // User-selected private book stays outside Git; assertions never print its text.
  if (process.env.MOMENTREAD_TEST_EPUB) it('validates the explicitly supplied real EPUB without persisting its contents', async () => {
    provide(readFileSync(process.env.MOMENTREAD_TEST_EPUB!));
    const epub = await loadEpub('/api/files/user-book', new AbortController().signal);
    try {
      expect(epub.sections.length > 1).toBe(true); expect((epub.toc?.length ?? 0) > 1).toBe(true);
      let checked = 0;
      for (const section of epub.sections) {
        const doc = await section.createDocument();
        expect(doc.querySelector('script,iframe')).toBeNull();
        const paragraphs = Array.from(doc.querySelectorAll('p')).filter(p => p.textContent?.trim());
        if (paragraphs.length < 2) continue;
        const range = doc.createRange(); range.setStartBefore(paragraphs[0]); range.setEndAfter(paragraphs[1]);
        const segment = rangeSegment(range, { spineId: section.id, chapter: '', baseCFI: section.cfi });
        const location = epub.resolveCFI(segment.cfi);
        const fresh = await epub.sections[location.index].createDocument();
        // Boolean avoids printing copyrighted source if the comparison fails.
        const restored = typeof location.anchor === 'function' ? location.anchor(fresh) : null;
        expect(restored?.toString() === segment.exact, JSON.stringify({ section: section.id, cfi: segment.cfi, selectedLength: segment.exact.length, restoredLength: restored?.toString().length, startType: range.startContainer.nodeName, startOffset: range.startOffset, endOffset: range.endOffset })).toBe(true);
        checked++;
      }
      expect(checked > 1).toBe(true);
    } finally { epub.destroy(); }
  });
});
