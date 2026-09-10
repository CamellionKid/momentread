/** EPUB content is untrusted. This policy belongs to each book document, not the app. */
export const BOOK_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const XHTML = 'http://www.w3.org/1999/xhtml';
const forbidden = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'base', 'audio', 'video', 'source', 'track', 'animate', 'animatemotion', 'animatetransform', 'set', 'foreignobject']);
const resourceAttrs = new Set(['src', 'poster', 'data', 'background', 'action', 'formaction']);

export function isPackagedResource(value: string, transformed = false): boolean {
  const v = value.trim().replace(/[\u0000-\u0020]/g, '');
  if (!v || v.startsWith('#')) return true;
  if (transformed && /^blob:/i.test(v)) return true;
  // SVG data can carry active content. Only allow raster image/font data.
  if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/[a-z0-9.+-]+);base64,/i.test(v)) return true;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\\)/i.test(v);
}

export function sanitizeCSS(css: string, transformed = false): string {
  // Reject escape-obfuscated URLs. Packaged image/font URLs have no need for CSS escapes.
  return css.replace(/@import\s+(?:url\([^)]*\)|['"][^'"]*['"])[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_whole, _q, value: string) =>
      !value.includes('\\') && isPackagedResource(value, transformed) ? `url("${value.replace(/"/g, '%22')}")` : 'none')
    .replace(/(?:-moz-binding|behavior)\s*:[^;}]+;?/gi, '');
}

/** Must run before and after foliate resolves resource references to blob URLs. */
export function sanitizeDocument(source: string, mediaType = 'application/xhtml+xml', transformed = false): string {
  const parser = new DOMParser();
  let doc = parser.parseFromString(source, mediaType === 'image/svg+xml' ? 'image/svg+xml' : 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) {
    if (mediaType === 'image/svg+xml') return '<svg xmlns="http://www.w3.org/2000/svg"/>';
    doc = parser.parseFromString(source, 'text/html');
  }
  for (const child of Array.from(doc.childNodes)) if (child.nodeType === 7) child.remove();
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    const name = element.localName.toLowerCase();
    if (forbidden.has(name) || name === 'meta') { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const key = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (key.startsWith('on') || ['srcdoc', 'srcset', 'ping', 'autofocus', 'contenteditable'].includes(key)) element.removeAttributeNode(attribute);
      else if (key === 'style') element.setAttribute('style', sanitizeCSS(value, transformed));
      else if (resourceAttrs.has(key) && !isPackagedResource(value, transformed)) element.removeAttributeNode(attribute);
      else if (key === 'href') {
        // Anchors are handled by the parent application; executable schemes are never retained.
        const executable = /^(?:javascript|vbscript|data|blob):/i.test(value.trim().replace(/[\u0000-\u0020]/g, ''));
        if ((name === 'a' && executable) || (name !== 'a' && !isPackagedResource(value, transformed))) element.removeAttributeNode(attribute);
      }
    }
    if (name === 'style') element.textContent = sanitizeCSS(element.textContent ?? '', transformed);
    if (name === 'link' && element.getAttribute('rel')?.toLowerCase() !== 'stylesheet') element.remove();
  }
  if (mediaType !== 'image/svg+xml') {
    let head = doc.querySelector('head');
    if (!head) { head = doc.createElementNS(XHTML, 'head'); doc.documentElement.prepend(head); }
    const policy = doc.createElementNS(XHTML, 'meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute('content', BOOK_CSP);
    head.prepend(policy);
  }
  return new XMLSerializer().serializeToString(doc);
}
