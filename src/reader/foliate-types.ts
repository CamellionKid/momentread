export interface TOCItem { label: string; href: string; subitems?: TOCItem[] }
export interface Section { id: string; cfi: string; size: number; linear?: string; load(): Promise<string>; createDocument(): Promise<Document>; resolveHref(href: string): string }
export interface Target { index: number; anchor?: number | ((doc: Document) => Range | Element | number | null); select?: boolean }
export interface EpubBook { sections: Section[]; toc?: TOCItem[]; rendition?: { layout?: string }; transformTarget: EventTarget; resolveCFI(cfi: string): Target; resolveHref(href: string): Target | null; destroy(): void }
export interface Renderer extends HTMLElement { open(book: EpubBook): void; goTo(target: Target): Promise<void>; prev(): Promise<void>; next(): Promise<void>; setStyles(css: string): void; getContents(): { index: number; doc: Document }[]; destroy(): void }
