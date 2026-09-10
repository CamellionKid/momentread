import type { Book, TextReference } from '../../shared/contracts';
import * as CFI from '../../vendor/foliate-js/epubcfi.js';

export function assertReferenceBook(reference: TextReference, book: Book): void {
  if (reference.bookId !== book.id) throw new Error('这段引用属于另一本书，不能在当前书中定位。');
  if (reference.fileVersionId !== book.fileVersionId) throw new Error('书籍文件版本已变化，请打开原文件版本核对引用。');
  if (!reference.segments.length) throw new Error('引用中没有可定位的选段。');
}

export function rangeSegment(selected: Range, input: { spineId: string; chapter: string; baseCFI: string }) {
  const doc = selected.startContainer.ownerDocument;
  if (!doc || doc !== selected.endContainer.ownerDocument || !doc.body?.contains(selected.commonAncestorContainer))
    throw new Error('一次选取须在同一章节内完成。跨章节请分次选取，不能合并成一个拖选范围。');
  // foliate's CFI encoder drops element child offsets. Normalize select-all and
  // paragraph-boundary ranges to equivalent text offsets before encoding.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: { node: Node; start: number; end: number }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!selected.intersectsNode(node)) continue;
    const start = node === selected.startContainer ? selected.startOffset : 0;
    const end = node === selected.endContainer ? selected.endOffset : (node.textContent?.length ?? 0);
    if (end > start) parts.push({ node, start, end });
  }
  if (!parts.length) throw new Error('请先选取正文文字。');
  const range = doc.createRange();
  range.setStart(parts[0].node, parts[0].start);
  range.setEnd(parts.at(-1)!.node, parts.at(-1)!.end);
  const exact = range.toString();
  if (exact !== selected.toString()) throw new Error('无法完整保存这一选区，请重新选取正文文字。');
  if (!exact.trim()) throw new Error('请先选取正文文字。');
  const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEnd(range.startContainer, range.startOffset);
  const after = doc.createRange(); after.selectNodeContents(doc.body); after.setStart(range.endContainer, range.endOffset);
  return { spineId: input.spineId, chapter: input.chapter, cfi: CFI.joinIndir(input.baseCFI, CFI.fromRange(range)), exact,
    prefix: before.toString().slice(-160), suffix: after.toString().slice(0, 160) };
}

export function progressFraction(sizes: number[], index: number, fraction: number): number {
  const total = sizes.reduce((a, b) => a + Math.max(0, b), 0);
  if (!total) return 0;
  const bounded = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.max(0, Math.min(1, (sizes.slice(0, index).reduce((a, b) => a + Math.max(0, b), 0) + Math.max(0, sizes[index] ?? 0) * bounded) / total));
}
