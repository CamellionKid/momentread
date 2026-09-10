import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CaretLeft, CaretRight, List, X } from '@phosphor-icons/react';
import type { ReaderHandle, ReaderProps } from '../../shared/contracts/ports';
import type { ReadingPosition, TextReference } from '../../shared/contracts';
import { loadEpub } from './load-book';
import { waitForChapter } from './chapter-load';
import { assertReferenceBook, progressFraction, rangeSegment } from './references';
import type { EpubBook, Renderer, Target, TOCItem } from './foliate-types';
import * as CFI from '../../vendor/foliate-js/epubcfi.js';
import './reader.css';

interface ReadingInstance { epub: EpubBook; renderer: Renderer; navigate: (target: Target) => Promise<void> }
const flattenToc = (items: TOCItem[], depth = 0): (TOCItem & { depth: number })[] => items.flatMap(item => [{ ...item, depth }, ...flattenToc(item.subitems ?? [], depth + 1)]);
const typography = (size: number) => `
  html { background:#191a1c!important; color:#d5d5d2!important; color-scheme:dark; }
  body { background:#191a1c!important; color:#d5d5d2!important; font-family:"Songti SC","STSong","Noto Serif SC",serif!important; font-size:${Math.max(16, Math.min(36, size))}px!important; line-height:1.85!important; }
  body * { color:inherit!important; background-color:transparent!important; font-family:inherit!important; }
  body p, body li { font-size:1em!important; font-weight:400!important; line-height:1.85!important; }
  body strong,body b { font-weight:700!important; }
  body pre,body code { font-family:ui-monospace,monospace!important; }
  p { margin-block:1.15em!important; } h1,h2,h3 { font-family:inherit!important; line-height:1.5!important; }
  img,svg { max-width:100%!important; height:auto; } a { text-decoration-color:#787a7f!important; }
  ::selection { background:#4a4c50!important; color:#fff!important; }
`;

/** UI-independent foliate adapter: references/positions out, explicit navigation in. */
export const EpubReader = forwardRef<ReaderHandle, ReaderProps>(function EpubReader(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const instance = useRef<ReadingInstance | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [toc, setToc] = useState<(TOCItem & { depth: number })[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [chapter, setChapter] = useState('正在打开书籍');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalSections, setTotalSections] = useState(0);
  const [progress, setProgress] = useState(0);
  const [selectionCount, setSelectionCount] = useState(0);
  const [referenceSegments, setReferenceSegments] = useState<TextReference['segments']>([]);
  const [retry, setRetry] = useState(0);
  const tocButton = useRef<HTMLButtonElement>(null);
  const warn = (message: string) => { setError(message); callbacks.current.onError(message); };
  const requiredInstance = () => {
    if (!instance.current) throw new Error('书籍仍在加载，请稍后重试。');
    return instance.current;
  };
  const validTarget = (epub: EpubBook, target: Target | null) => {
    if (!target || !Number.isInteger(target.index) || target.index < 0 || target.index >= epub.sections.length) throw new Error('无法定位到这段正文，请核对书籍与文件版本。');
    return target;
  };
  const navigateSegment = async (segment: TextReference['segments'][number]) => {
    const { epub, navigate } = requiredInstance();
    const target = validTarget(epub, epub.resolveCFI(segment.cfi));
    if (epub.sections[target.index].id !== segment.spineId) throw new Error('引用的章节与定位不一致，已停止跳转。');
    const doc = await epub.sections[target.index].createDocument();
    const range = typeof target.anchor === 'function' ? target.anchor(doc) : null;
    if (!range || range.toString() !== segment.exact) throw new Error('引用位置的文字与保存选段不一致，请核对原文件。');
    await navigate({ ...target, select: true });
    const loadedDoc = instance.current?.renderer.getContents().find(content => content.index === target.index)?.doc;
    if (loadedDoc && typeof target.anchor === 'function') {
      const loadedRange = target.anchor(loadedDoc);
      if (loadedRange && typeof loadedRange === 'object' && 'startContainer' in loadedRange) {
        const selection = loadedDoc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(loadedRange as Range);
      }
    }
  };

  useImperativeHandle(ref, () => ({
    async restorePosition(position) {
      if (position.fileVersionId !== callbacks.current.book.fileVersionId) throw new Error('阅读位置属于其他文件版本，无法自动恢复。');
      const { epub, navigate } = requiredInstance();
      await navigate(validTarget(epub, epub.resolveCFI(position.cfi)));
    },
    async navigateToReference(reference) {
      assertReferenceBook(reference, callbacks.current.book);
      // Validate every segment before navigating; never silently drop a multi-range reference.
      const { epub } = requiredInstance();
      for (const segment of reference.segments) {
        const target = validTarget(epub, epub.resolveCFI(segment.cfi));
        const doc = await epub.sections[target.index].createDocument();
        if (epub.sections[target.index].id !== segment.spineId || typeof target.anchor !== 'function' || target.anchor(doc)?.toString() !== segment.exact)
          throw new Error('引用中的选段与当前文件不一致，已停止跳转。');
      }
      setReferenceSegments(reference.segments);
      await navigateSegment(reference.segments[0]);
    },
    setTypography(size) { instance.current?.renderer.setStyles(typography(size)); },
  }));

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false, loadedBook: EpubBook | undefined, renderer: Renderer | undefined;
    const listeners: (() => void)[] = [];
    setPhase('loading'); setError(''); setSelectionCount(0); setReferenceSegments([]); setTocOpen(false);
    const startPosition = callbacks.current.position;
    const onLoad = (event: Event) => {
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
      const select = () => {
        if (disposed || !loadedBook) return;
        const selection = doc.defaultView?.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelectionCount(0); return; }
        try {
          const segments = Array.from({ length: selection.rangeCount }, (_, i) => rangeSegment(selection.getRangeAt(i), {
            spineId: loadedBook!.sections[index].id,
            chapter: chapterFor(index), baseCFI: loadedBook!.sections[index].cfi,
          }));
          setSelectionCount(segments.reduce((sum, segment) => sum + segment.exact.length, 0));
          callbacks.current.onSelection({ bookId: callbacks.current.book.id, fileVersionId: callbacks.current.book.fileVersionId, segments });
        } catch (e) { warn(e instanceof Error ? e.message : '无法读取选区。'); }
      };
      const keyup = (event: KeyboardEvent) => { if (event.key === 'Shift' || event.shiftKey) select(); };
      const keydown = (event: KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'PageDown' || event.key === 'PageUp') {
          event.preventDefault(); void (event.key === 'PageDown' ? renderer?.next() : renderer?.prev());
        }
      };
      const links = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest?.('a');
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) { warn('书中的外部链接未自动打开。'); return; }
        try {
          const target = loadedBook!.resolveHref(loadedBook!.sections[index].resolveHref(href));
          void instance.current?.navigate(validTarget(loadedBook!, target)).catch(e => warn(e.message));
        } catch { warn('无法定位这条书内链接。'); }
      };
      doc.addEventListener('mouseup', select);
      doc.addEventListener('touchend', select);
      doc.addEventListener('keyup', keyup);
      doc.addEventListener('keydown', keydown);
      doc.addEventListener('click', links);
      listeners.push(() => { doc.removeEventListener('mouseup', select); doc.removeEventListener('touchend', select); doc.removeEventListener('keyup', keyup); doc.removeEventListener('keydown', keydown); doc.removeEventListener('click', links); });
    };
    let flatToc: (TOCItem & { depth: number })[] = [];
    const chapterFor = (index: number) => {
      const section = loadedBook?.sections[index];
      return flatToc.find(item => item.href.split('#')[0] === section?.id)?.label || `第 ${index + 1} 节`;
    };
    const onRelocate = (event: Event) => {
      if (disposed || !loadedBook) return;
      const detail = (event as CustomEvent<{ index: number; range: Range; fraction: number }>).detail;
      if (!loadedBook.sections[detail.index] || !detail.range) return;
      const range = detail.range.cloneRange(); range.collapse(true);
      const name = chapterFor(detail.index);
      const position: ReadingPosition = {
        fileVersionId: callbacks.current.book.fileVersionId,
        cfi: CFI.joinIndir(loadedBook.sections[detail.index].cfi, CFI.fromRange(range)),
        progress: progressFraction(loadedBook.sections.map(section => section.linear === 'no' ? 0 : section.size), detail.index, detail.fraction), chapter: name,
      };
      setChapter(name); setCurrentIndex(detail.index); setProgress(position.progress);
      callbacks.current.onRelocate(position);
    };
    void (async () => {
      try {
        loadedBook = await loadEpub(props.fileUrl, controller.signal);
        if (disposed) { loadedBook.destroy(); return; }
        await import('../../vendor/foliate-js/paginator.js');
        if (disposed) { loadedBook.destroy(); return; }
        renderer = document.createElement('foliate-paginator') as Renderer;
        renderer.setAttribute('flow', 'scrolled');
        renderer.setAttribute('margin', '28px');
        renderer.setAttribute('gap', '10%');
        renderer.setAttribute('max-inline-size', '760px');
        renderer.setAttribute('max-column-count', '1');
        renderer.addEventListener('load', onLoad); renderer.addEventListener('relocate', onRelocate);
        host.current?.append(renderer);
        flatToc = flattenToc(loadedBook.toc ?? []);
        if (!flatToc.length) flatToc = loadedBook.sections.map((section, index) => ({ label: `第 ${index + 1} 节`, href: section.id, depth: 0 }));
        setToc(flatToc); setTotalSections(loadedBook.sections.length);
        renderer.open(loadedBook); renderer.setStyles(typography(callbacks.current.fontSize));
        const navigate = async (target: Target) => {
          validTarget(loadedBook!, target);
          setError(''); setSelectionCount(0);
          await waitForChapter(renderer!.goTo(target));
          if (!renderer!.getContents().some(content => content.index === target.index)) throw new Error('章节加载失败，请重试。');
        };
        instance.current = { epub: loadedBook, renderer, navigate };
        if (startPosition?.cfi && startPosition.fileVersionId === props.book.fileVersionId) {
          try { await navigate(validTarget(loadedBook, loadedBook.resolveCFI(startPosition.cfi))); }
          catch { await navigate({ index: Math.max(0, loadedBook.sections.findIndex(s => s.linear !== 'no')) }); warn('上次位置无法恢复，已打开本书开头。'); }
        } else {
          if (startPosition?.cfi) warn('阅读位置属于其他文件版本，已打开本书开头。');
          await navigate({ index: Math.max(0, loadedBook.sections.findIndex(s => s.linear !== 'no')) });
        }
        if (!disposed) { setPhase('ready'); callbacks.current.onReady(); }
      } catch (e) {
        if (disposed || controller.signal.aborted) return;
        setPhase('error'); warn(e instanceof Error ? e.message : '书籍加载失败。');
      }
    })();
    return () => {
      disposed = true; controller.abort(); instance.current = null;
      listeners.forEach(remove => remove());
      renderer?.removeEventListener('load', onLoad); renderer?.removeEventListener('relocate', onRelocate);
      // Upstream destroy assumes a view already exists; loading may be cancelled earlier.
      if (renderer?.getContents().length) renderer.destroy();
      renderer?.remove(); loadedBook?.destroy();
    };
  }, [props.book.id, props.book.fileVersionId, props.fileUrl, retry]);

  useEffect(() => { instance.current?.renderer.setStyles(typography(props.fontSize)); }, [props.fontSize]);
  const turn = async (direction: -1 | 1, wholeChapter = false) => {
    try {
      const { epub, renderer, navigate } = requiredInstance(); setError(''); setSelectionCount(0); setReferenceSegments([]);
      if (wholeChapter) await navigate({ index: Math.min(epub.sections.length - 1, Math.max(0, currentIndex + direction)) });
      else await (direction < 0 ? renderer.prev() : renderer.next());
    } catch (e) { warn(e instanceof Error ? e.message : '无法翻页。'); }
  };
  return <section className="mr-epub-reader" aria-label="EPUB 阅读器">
    <div className="mr-reader-toolbar">
      <button ref={tocButton} type="button" onClick={() => setTocOpen(!tocOpen)} aria-expanded={tocOpen} aria-controls="mr-epub-toc" disabled={phase !== 'ready'}><List size={19} />目录</button>
      <span className="mr-current-chapter" title={chapter}>{chapter}</span>
      <div className="mr-chapter-buttons"><button type="button" aria-label="上一章节" disabled={phase !== 'ready' || currentIndex <= 0} onClick={() => void turn(-1, true)}><CaretLeft size={17} /></button><button type="button" aria-label="下一章节" disabled={phase !== 'ready' || currentIndex >= totalSections - 1} onClick={() => void turn(1, true)}><CaretRight size={17} /></button></div>
    </div>
    {tocOpen && <nav className="mr-reader-toc" id="mr-epub-toc" aria-label="书籍目录" onKeyDown={event => { if (event.key === 'Escape') { setTocOpen(false); tocButton.current?.focus(); } }}>
      <div className="mr-toc-heading"><strong>目录</strong><button aria-label="关闭目录" type="button" onClick={() => { setTocOpen(false); tocButton.current?.focus(); }}><X size={18} /></button></div>
      {toc.map((item, index) => <button type="button" key={`${item.href}-${index}`} className={item.label === chapter ? 'is-current' : ''} style={{ paddingInlineStart: 18 + item.depth * 16 }} onClick={() => {
        try { const { epub, navigate } = requiredInstance(); void navigate(validTarget(epub, epub.resolveHref(item.href))).then(() => setTocOpen(false)).catch(e => warn(e.message)); }
        catch (e) { warn((e as Error).message); }
      }}>{item.label}</button>)}
    </nav>}
    <div className="mr-reader-body" ref={host} />
    {phase === 'loading' && <div className="mr-reader-loading" role="status"><span className="mr-loading-line" />正在打开 EPUB…</div>}
    {error && <div className="mr-reader-error" role="alert">{error}{phase === 'error' ? <button type="button" onClick={() => setRetry(value => value + 1)}>重新加载</button> : <button type="button" aria-label="关闭阅读提示" onClick={() => setError('')}><X size={16} /></button>}</div>}
    {referenceSegments.length > 1 && <div className="mr-reference-segments" aria-label="引用的多个选段">此引用含 {referenceSegments.length} 段{referenceSegments.map((segment, index) => <button type="button" key={segment.cfi} onClick={() => void navigateSegment(segment).catch(e => warn(e.message))}>第 {index + 1} 段</button>)}</div>}
    <div className="mr-reader-footer">
      <div className="mr-reader-hint" role="status">{selectionCount ? `已选 ${selectionCount} 字` : '选中文字即可解析 · 跨章节请分次选取'}</div>
      <div className="mr-reader-paging"><button type="button" aria-label="上一页" disabled={phase !== 'ready'} onClick={() => void turn(-1)}><CaretLeft size={17} /></button><span aria-label="阅读进度">{Math.round(progress * 100)}%</span><button type="button" aria-label="下一页" disabled={phase !== 'ready'} onClick={() => void turn(1)}><CaretRight size={17} /></button></div>
    </div>
  </section>;
});
