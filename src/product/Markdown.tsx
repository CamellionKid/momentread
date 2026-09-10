import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownSourcePlugins } from "./markdown-source";
export function safeMarkdownHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
/** No raw HTML and no automatic external media requests. */
export function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const plugins = useMemo(() => markdownSourcePlugins(text), [text]);
  return (
    <div className={`product-markdown ${className}`} data-mr-markdown="true">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, plugins.remark]}
        rehypePlugins={[plugins.rehype]}
        components={{
          a: ({ href, children }) => {
            const safe = safeMarkdownHref(href);
            return safe ? (
              <a
                href={safe}
                target={safe.startsWith("#") ? undefined : "_blank"}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => (
            <span className="product-markdown-image" data-mr-unmapped="true">
              [图片未自动加载{alt ? `：${alt}` : ""}]
            </span>
          ),
          table: ({ children }) => (
            <div
              className="product-markdown-table"
              tabIndex={0}
              role="region"
              aria-label="可横向滚动的表格"
            >
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="代码块">
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
