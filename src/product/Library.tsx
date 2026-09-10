import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  MagnifyingGlass,
  Plus,
  UploadSimple,
  DownloadSimple,
} from "@phosphor-icons/react";
import type { Book, BookState } from "../../shared/contracts";
export function Library({
  books,
  state,
  loading,
  onOpen,
  onImport,
  onRestore,
  onBackup,
}: {
  books: Book[];
  state: BookState | null;
  loading: boolean;
  onOpen: (id: string) => void;
  onImport: () => void;
  onRestore: () => void;
  onBackup: () => void;
}) {
  const [query, setQuery] = useState("");
  const found = books.filter((book) =>
    `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase()),
  );
  const active = state?.discussions.find(
    (d) => d.id === state.workspace.activeDiscussionId,
  );
  return (
    <main className="library-page">
      <div className="page-heading">
        <p className="eyebrow">YOUR READING, CONTINUED</p>
        <h1>读过的，慢慢成为自己的。</h1>
        <p>一本书，一条阅读主线。疑问可以分岔，也可以带着理解回来。</p>
      </div>
      <div className="library-layout">
        <section>
          <div className="list-heading">
            <span>
              我的书架 <small>{books.length} 本</small>
            </span>
            <label className="search-input">
              <MagnifyingGlass size={18} />
              <input
                aria-label="搜索书籍"
                placeholder="搜索书名或作者"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          {loading ? (
            <p role="status" className="quiet-note">
              正在读取书库…
            </p>
          ) : found.length ? (
            found.map((book, index) => (
              <article
                className={`book-row ${state?.book.id === book.id ? "featured" : ""}`}
                key={book.id}
              >
                <span className="book-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="book-row-body">
                  <span className="author">{book.author || "作者未标注"}</span>
                  <button
                    className="book-title"
                    onClick={() => onOpen(book.id)}
                  >
                    {book.title}
                  </button>
                  <p>{book.language || "语言未标注"} · 已保存到本地书库</p>
                  <div className="book-row-foot">
                    <span>
                      {state?.book.id === book.id
                        ? `${Math.round((state.workspace.position?.progress ?? 0) * 100)}% · ${state.workspace.position?.chapter || "尚未开始"}`
                        : "打开后接续上次位置"}
                    </span>
                    <button
                      className="text-button"
                      onClick={() => onOpen(book.id)}
                    >
                      打开阅读 <ArrowRight size={17} />
                    </button>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <BookOpen size={35} weight="light" />
              <h3>{query ? "没有找到这本书" : "从一本书开始"}</h3>
              <p>
                {query
                  ? "换个书名或作者试试。"
                  : "导入可复制文字的 EPUB，在读不懂的地方展开讨论。"}
              </p>
              {!query && (
                <button className="primary" onClick={onImport}>
                  <Plus size={18} /> 导入 EPUB
                </button>
              )}
            </div>
          )}
        </section>
        <aside className="resume-aside">
          <p className="eyebrow">
            {state ? "CONTINUE READING" : "A QUIETER WAY TO READ"}
          </p>
          <h2>{state?.book.title || "保留阅读的节奏，\n安放临时的疑问。"}</h2>
          <p>
            {state
              ? active
                ? `上次停在「${active.title}」。讨论、小结和阅读位置都在这里。`
                : "可以继续阅读正文，或在选段中开始第一场讨论。"
              : "导入后会在本地保存一份副本，原文件移动也不会打断阅读。"}
          </p>
          {state && (
            <button
              className="text-button"
              onClick={() => onOpen(state.book.id)}
            >
              接着读 <ArrowRight size={18} />
            </button>
          )}
          <div className="aside-rule" />
          <button className="aside-row" onClick={onImport}>
            导入新的 EPUB <Plus size={18} />
          </button>
          <button
            className="aside-row"
            onClick={onBackup}
            disabled={!books.length}
          >
            备份整个书库 <DownloadSimple size={18} />
          </button>
          <button
            className="aside-row"
            onClick={onRestore}
            disabled={!!books.length}
          >
            从备份恢复 <UploadSimple size={18} />
          </button>
          <p className="quiet-note">
            恢复仅适用于空书库。AI 解析会使用你选中的文字和必要背景。
          </p>
        </aside>
      </div>
    </main>
  );
}
