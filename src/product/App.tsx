import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ArrowLeft,
  FileText,
  GearSix,
  Plus,
  TextAa,
  X,
  Check,
  GitBranch,
} from "@phosphor-icons/react";
import { api, ApiError } from "../api";
import type {
  Book,
  SummaryVersion,
  TextReference,
} from "../../shared/contracts";
import type { ReaderHandle, RuntimeProbe } from "../../shared/contracts/ports";
import { EpubReader } from "../reader/EpubReader";
import { useWorkspace } from "./useWorkspace";
import { Dialog } from "./Dialog";
import { Markdown } from "./Markdown";
import { BookDetails } from "./BookDetails";
import { Library } from "./Library";
import { DiscussionPane, type BranchSelection } from "./DiscussionPane";
import { RouteRail } from "./RouteRail";
import {
  ConceptsPanel,
  HistoryPanel,
  ImportPanel,
  ReportPage,
  RuntimePanel,
  SourcePanel,
} from "./Panels";
import { ancestry, isActiveRun } from "./model";
import "./styles.css";
type Screen = "library" | "reader" | "report";
type Modal =
  | "book-details"
  | "import"
  | "original"
  | "restore"
  | "runtime"
  | "font"
  | "source"
  | "history"
  | "concepts"
  | "ancestors"
  | null;
type Preview = {
  summary: SummaryVersion;
  text: string;
  requestId: string;
  error: string;
  conflict: boolean;
};
export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("library");
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<RuntimeProbe | null>(null);
  const [smallPanel, setSmallPanel] = useState<"reading" | "discussion">(
    "reading",
  );
  const [selection, setSelection] = useState<TextReference | null>(null);
  const [branch, setBranch] = useState<BranchSelection | null>(null);
  const [branchTitle, setBranchTitle] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [readerReady, setReaderReady] = useState(false);
  const reader = useRef<ReaderHandle>(null);
  const dismissedSummaries = useRef(new Set<string>());
  const confirmKeys = useRef(new Map<string, string>());
  const retainedSummaryText = useRef<string | null>(null);
  const pendingLocate = useRef<TextReference | null>(null);
  const fail = useCallback((message: string) => setError(message), []);
  const model = useWorkspace(fail);
  const { state } = model;
  const node =
    state?.discussions.find(
      (d) => d.id === state.workspace.activeDiscussionId,
    ) ?? null;
  const activeNodeRef = useRef(node);
  activeNodeRef.current = node;
  const refreshBooks = async () => {
    const value = await api.books();
    setBooks(value);
    return value;
  };
  const runAction = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const openBook = async (id: string) => {
    await model.open(id);
    setScreen("reader");
    setSmallPanel("reading");
    setSelection(null);
    setReaderReady(false);
  };
  useEffect(() => {
    let disposed = false;
    void api
      .books()
      .then(async (value) => {
        if (disposed) return;
        setBooks(value);
        const saved = localStorage.getItem("momentread.currentBook");
        if (saved && value.some((book) => book.id === saved)) {
          await model.open(saved);
          if (!disposed) setScreen("reader");
        }
      })
      .catch((e) => {
        if (!disposed) fail(e.message);
      })
      .finally(() => {
        if (!disposed) setBooksLoading(false);
      });
    void api
      .runtime()
      .then((value) => {
        if (!disposed) setProbe(value);
      })
      .catch((e) => {
        if (!disposed) fail(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const showPreview = useCallback((summary: SummaryVersion) => {
    let requestId = confirmKeys.current.get(summary.id);
    if (!requestId) {
      requestId = crypto.randomUUID();
      confirmKeys.current.set(summary.id, requestId);
    }
    setPreview({
      summary,
      text: retainedSummaryText.current ?? summary.content,
      requestId,
      error: "",
      conflict: false,
    });
    retainedSummaryText.current = null;
  }, []);
  useEffect(() => {
    if (!state || !node || preview) return;
    const draft = state.summaries
      .filter((s) => s.discussionId === node.id && !s.confirmed)
      .at(-1);
    if (draft && !dismissedSummaries.current.has(draft.id)) {
      dismissedSummaries.current.add(draft.id);
      showPreview(draft);
    }
  }, [state?.summaries, node?.id, preview, showPreview]);
  async function selectNode(id: string) {
    await model.activate(id);
    setSmallPanel("discussion");
    setModal(null);
    setBranch(null);
  }
  async function analyze() {
    if (!selection || !state) return;
    await model.flush();
    const result = await api.analyze({
      source: selection,
      question: "解释这段文字，包括原文依据、内容拆解和例子。",
    });
    await model.refresh();
    await model.activate(result.discussionId);
    setSelection(null);
    setSmallPanel("discussion");
  }
  async function send() {
    const current = activeNodeRef.current;
    if (!current?.draft.trim()) return;
    const text = current.draft;
    await model.flush();
    await api.message(current.id, text);
    model.edit(current.id, { draft: "" });
    await model.flush();
    await model.refresh();
  }
  async function createBranch() {
    if (!branch || !branchTitle.trim()) return;
    await model.flush();
    const result = await api.branch({
      parentId: branch.parentId,
      title: branchTitle.trim(),
      origin: branch.origin,
    });
    setBranch(null);
    setBranchTitle("");
    await model.refresh();
    await model.activate(result.discussionId);
    setSmallPanel("discussion");
  }
  async function summarize() {
    if (!node) return;
    await model.flush();
    await api.summary(node.id);
    await model.refresh();
  }
  async function confirm() {
    if (!preview || !preview.text.trim()) return;
    setBusy(true);
    const current = preview;
    setPreview({ ...current, error: "" });
    try {
      const result = await api.confirm(
        current.summary.id,
        current.text,
        current.requestId,
      );
      setPreview(null);
      await model.refresh();
      if (result.parentId) await model.activate(result.parentId);
      setNotice(
        result.parentId ? "小结已保存并回馈到直接父讨论。" : "本段小结已保存。",
      );
    } catch (e) {
      setPreview((previous) =>
        previous
          ? {
              ...previous,
              error: (e as Error).message,
              conflict: e instanceof ApiError && e.status === 409,
            }
          : previous,
      );
    } finally {
      setBusy(false);
    }
  }
  async function locate() {
    if (!state || !node) return;
    const reference = state.discussions.find(
      (d) => d.id === node.rootId,
    )?.source;
    if (!reference) {
      setNotice("这场讨论没有可定位的正文引用。");
      return;
    }
    setSmallPanel("reading");
    if (readerReady && reader.current)
      await reader.current.navigateToReference(reference);
    else pendingLocate.current = reference;
  }
  async function backup() {
    await model.flush();
    const result = await api.backup();
    const link = document.createElement("a");
    link.href = `/api/backups/${result.id}`;
    link.download = "MomentRead-backup.zip";
    document.body.append(link);
    link.click();
    link.remove();
    setNotice("备份已准备下载，包含书籍和已保存的学习记录。");
  }
  function closePreview() {
    if (preview) dismissedSummaries.current.add(preview.summary.id);
    setPreview(null);
  }
  const root = state?.discussions.find((d) => d.id === node?.rootId);
  const path = state ? ancestry(state.discussions, node?.id ?? null) : [];
  const analyzedRefs = useMemo(
    () =>
      state?.discussions
        .filter((d) => !d.parentId && d.source)
        .map((d) => d.source as TextReference) ?? [],
    [state?.discussions],
  );
  return (
    <div className="product-app">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="brand"
            aria-label="MomentRead 书架"
            onClick={() =>
              void runAction(async () => {
                await model.flush();
                setScreen("library");
                await refreshBooks();
              })
            }
          >
            <BookOpen size={22} weight="light" />
            <span>MomentRead</span>
          </button>
          {state && screen !== "library" && (
            <>
              <span className="top-divider" />
              <button
                className="top-book"
                title="查看与补充书籍资料"
                aria-label="书籍资料"
                onClick={() => setModal("book-details")}
              >
                {state.book.title}
              </button>
            </>
          )}
        </div>
        <nav className="topbar-actions" aria-label="主要导航">
          {screen === "library" ? (
            <button className="text-button" onClick={() => setModal("import")}>
              <Plus size={18} /> 导入 EPUB
            </button>
          ) : (
            <>
              <button
                className="text-button product-original-button"
                onClick={() => setModal("original")}
              >
                补充原著
              </button>
              <button
                className="icon-button"
                title="阅读设置"
                aria-label="阅读设置"
                onClick={() => setModal("font")}
              >
                <TextAa size={20} />
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void runAction(async () => {
                    await model.flush();
                    setScreen(screen === "report" ? "reader" : "report");
                  })
                }
              >
                {screen === "report" ? (
                  <ArrowLeft size={17} />
                ) : (
                  <FileText size={17} />
                )}
                <span>{screen === "report" ? "回到阅读" : "今日小结"}</span>
              </button>
            </>
          )}
          <button
            className="icon-button"
            title="AI 连接与数据"
            aria-label="AI 连接与数据"
            onClick={() => setModal("runtime")}
          >
            <GearSix size={20} />
          </button>
        </nav>
      </header>
      {error && (
        <div className="product-global-error" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="关闭错误提示"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="product-notice" role="status">
          <Check size={16} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {model.permissions.map((permission) => (
        <div
          className="product-permission"
          role="alert"
          key={permission.requestId}
        >
          <div>
            <strong>
              {permission.toolName} ·{" "}
              {state?.discussions.find((d) => d.id === permission.discussionId)
                ?.title || "AI 运行"}
            </strong>
            <p>{permission.description}</p>
            <details>
              <summary>查看请求内容</summary>
              <pre>{JSON.stringify(permission.input, null, 2)}</pre>
            </details>
          </div>
          <div className="product-inline-actions">
            <button
              className="outline small"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  await api.permission(
                    permission.runId,
                    permission.requestId,
                    "denyRun",
                  );
                  await model.refresh();
                })
              }
            >
              拒绝本次检索
            </button>
            <button
              className="primary small"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  await api.permission(
                    permission.runId,
                    permission.requestId,
                    "allowRun",
                  );
                  await model.refresh();
                })
              }
            >
              允许本次检索
            </button>
          </div>
        </div>
      ))}
      {screen === "library" && (
        <Library
          books={books}
          state={state}
          loading={booksLoading}
          onOpen={(id) => void runAction(() => openBook(id))}
          onImport={() => setModal("import")}
          onRestore={() => setModal("restore")}
          onBackup={() => void runAction(backup)}
        />
      )}
      {screen === "reader" && state && (
        <>
          <nav className="compact-tabs" aria-label="阅读与讨论">
            <button
              className={smallPanel === "reading" ? "active" : ""}
              onClick={() => setSmallPanel("reading")}
            >
              阅读正文
            </button>
            <button
              className={smallPanel === "discussion" ? "active" : ""}
              onClick={() => setSmallPanel("discussion")}
            >
              AI 讨论{node ? ` · ${node.title}` : ""}
            </button>
          </nav>
          <main className={`workspace product-workspace show-${smallPanel}`}>
            <section
              className="reader-panel product-reader-panel"
              aria-label="正文"
            >
              <EpubReader
                key={state.book.fileVersionId}
                ref={reader}
                book={state.book}
                fileUrl={`/api/files/${state.book.fileVersionId}`}
                position={state.workspace.position}
                fontSize={state.workspace.fontSize}
                flow={state.workspace.flow}
                analyzed={analyzedRefs}
                onReady={() => {
                  setReaderReady(true);
                  if (pendingLocate.current) {
                    void reader.current
                      ?.navigateToReference(pendingLocate.current)
                      .catch((e) => fail(e.message));
                    pendingLocate.current = null;
                  }
                }}
                onSelection={(reference) => setSelection(reference)}
                onRelocate={model.relocate}
                onError={fail}
              />
              {selection && (
                <div className="product-selection-bar">
                  <div>
                    <span>
                      已选{" "}
                      {selection.segments.reduce(
                        (sum, s) => sum + s.exact.length,
                        0,
                      )}{" "}
                      字
                    </span>
                    <p>{selection.segments.map((s) => s.exact).join(" … ")}</p>
                  </div>
                  <button
                    className="primary small"
                    disabled={busy}
                    onClick={() => void runAction(analyze)}
                  >
                    解析一下
                  </button>
                  <button
                    className="icon-button"
                    aria-label="取消选段"
                    onClick={() => setSelection(null)}
                  >
                    <X size={17} />
                  </button>
                </div>
              )}
            </section>
            <DiscussionPane
              state={state}
              retries={model.retries}
              node={node}
              saveStatus={model.saveStatus}
              onDraft={(id, draft) => model.edit(id, { draft })}
              onScroll={(id, scrollTop) => model.edit(id, { scrollTop })}
              onSend={() => void runAction(send)}
              onSummary={() => void runAction(summarize)}
              onSelect={(id) => void runAction(() => selectNode(id))}
              onBranch={(value) => {
                setBranch(value);
                setBranchTitle(value.visibleText.trim().slice(0, 160));
              }}
              onSources={() => setModal("source")}
              onHistory={() => setModal("history")}
              onConcepts={() => setModal("concepts")}
              onLocate={() => void runAction(locate)}
              onCancel={(id) =>
                void runAction(async () => {
                  await api.cancel(id);
                  await model.refresh();
                })
              }
              onAncestors={() => setModal("ancestors")}
              onCollapse={() => {
                const keep = new Set(path.map((n) => n.id));
                model.workspace({
                  collapsed: state.discussions
                    .filter(
                      (d) =>
                        !keep.has(d.id) &&
                        state.discussions.some(
                          (child) => child.parentId === d.id,
                        ),
                    )
                    .map((d) => d.id),
                });
              }}
              onExpand={() => model.workspace({ collapsed: [] })}
              onPreview={showPreview}
              onRetrySave={() => void runAction(model.flush)}
            />
            <RouteRail
              nodes={state.discussions}
              active={node?.id ?? null}
              collapsed={state.workspace.collapsed}
              onSelect={(id) => void runAction(() => selectNode(id))}
              visible={smallPanel === "discussion"}
            />
          </main>
        </>
      )}
      {screen === "report" && state && (
        <ReportPage
          state={state}
          retries={model.retries}
          onReturn={() => setScreen("reader")}
          onError={fail}
          onGenerate={async (date, timezone) => {
            await model.flush();
            const result = await api.generateReport(
              state.book.id,
              date,
              timezone,
            );
            await model.refresh();
            return result;
          }}
        />
      )}
      {model.loading && (
        <div className="product-loading-overlay" role="status">
          正在恢复书籍和阅读状态…
        </div>
      )}
      {(modal === "import" || modal === "original" || modal === "restore") && (
        <ImportPanel
          kind={modal === "import" ? "book" : modal}
          bookId={state?.book.id}
          onClose={() => setModal(null)}
          onDone={(id) => {
            setModal(null);
            void runAction(async () => {
              await refreshBooks();
              if (id) await openBook(id);
              else if (modal === "original") {
                await model.refresh();
                setNotice("原著已补充；请重新寻找原著依据以核对对应选段。");
              } else setNotice("备份已恢复，可以从书架继续阅读。");
            });
          }}
        />
      )}
      {modal === "runtime" && (
        <RuntimePanel
          probe={probe}
          onClose={() => setModal(null)}
          onProbe={() =>
            void runAction(async () => setProbe(await api.runtime()))
          }
          onBackup={() => void runAction(backup)}
        />
      )}
      {modal === "book-details" && state && (
        <BookDetails
          book={state.book}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await model.refresh();
            await refreshBooks();
            setNotice("书籍资料已保存。");
          }}
        />
      )}
      {modal === "font" && state && (
        <Dialog title="阅读设置" onClose={() => setModal(null)}>
          <label className="setting-row">
            正文字号 <strong>{state.workspace.fontSize} px</strong>
          </label>
          <input
            className="full-range"
            aria-label="正文字号"
            type="range"
            min="16"
            max="36"
            value={state.workspace.fontSize}
            onChange={(e) =>
              model.workspace({ fontSize: Number(e.target.value) })
            }
          />
          <p
            className="font-preview"
            style={{ fontSize: state.workspace.fontSize }}
          >
            留一点时间，读懂一个概念。
          </p>
          <label className="setting-row">翻页模式</label>
          <div className="flow-options" role="group" aria-label="翻页模式">
            <button
              type="button"
              className={state.workspace.flow === "scrolled" ? "active" : ""}
              aria-pressed={state.workspace.flow === "scrolled"}
              onClick={() => model.workspace({ flow: "scrolled" })}
            >
              上下滚动
            </button>
            <button
              type="button"
              className={state.workspace.flow === "paginated" ? "active" : ""}
              aria-pressed={state.workspace.flow === "paginated"}
              onClick={() => model.workspace({ flow: "paginated" })}
            >
              左右翻页
            </button>
          </div>
          <p className="quiet-note">
            设置会保存到本书，并使用正文位置恢复阅读。
          </p>
        </Dialog>
      )}
      {modal === "source" && state && node && (
        <SourcePanel
          state={state}
          node={node}
          onClose={() => setModal(null)}
          onRefresh={model.refresh}
          onImport={() => setModal("original")}
          onRematch={() =>
            void runAction(async () => {
              if (!root) return;
              await api.matching(root.id);
              await model.refresh();
              setModal(null);
              setNotice("正在重新寻找原著依据，完成后可在原著面板核对。");
            })
          }
        />
      )}
      {modal === "history" && node && (
        <HistoryPanel node={node} onClose={() => setModal(null)} />
      )}
      {modal === "concepts" && state && (
        <ConceptsPanel
          state={state}
          onClose={() => setModal(null)}
          onSelect={(id) =>
            void runAction(async () => {
              await selectNode(id);
              setScreen("reader");
            })
          }
        />
      )}
      {modal === "ancestors" && state && (
        <Dialog title="当前讨论的完整路径" onClose={() => setModal(null)}>
          <nav className="product-path-list" aria-label="完整祖先路径">
            {path.map((item, index) => (
              <button
                key={item.id}
                style={{ paddingLeft: 12 + Math.min(index, 10) * 12 }}
                aria-current={item.id === node?.id ? "page" : undefined}
                onClick={() => void runAction(() => selectNode(item.id))}
              >
                <span>{index + 1}</span>
                {item.title}
              </button>
            ))}
          </nav>
          <p className="quiet-note">每次「整理并返回」只返回上一级。</p>
        </Dialog>
      )}
      {branch && (
        <Dialog
          title="展开概念讨论"
          onClose={() => {
            if (!busy) setBranch(null);
          }}
        >
          <p className="muted">
            新讨论会带上当前书籍和父讨论背景，拥有独立的提问与小结。
          </p>
          <blockquote className="product-branch-quote">
            {branch.visibleText}
          </blockquote>
          <label className="product-field">
            概念名称
            <input
              aria-label="概念名称"
              maxLength={160}
              value={branchTitle}
              onChange={(e) => setBranchTitle(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button
              className="outline"
              disabled={busy}
              onClick={() => setBranch(null)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !branchTitle.trim()}
              onClick={() => void runAction(createBranch)}
            >
              <GitBranch size={17} /> {busy ? "正在展开…" : "展开讨论"}
            </button>
          </div>
        </Dialog>
      )}
      {preview && (
        <Dialog
          title={
            preview.summary.discussionId === node?.id && node.parentId
              ? "整理并返回"
              : "确认讨论小结"
          }
          wide
          onClose={() => {
            if (!busy) closePreview();
          }}
        >
          <p className="muted">
            检查这次理解、适用语境和仍有疑问的部分。确认保存后，回馈给直接父讨论。
          </p>
          <textarea
            className="product-summary-editor"
            aria-label="编辑讨论小结"
            value={preview.text}
            onChange={(e) => setPreview({ ...preview, text: e.target.value })}
          />
          <details className="product-summary-preview">
            <summary>查看排版预览</summary>
            <Markdown text={preview.text} />
          </details>
          {preview.error && (
            <p role="alert" className="product-error">
              {preview.error}
            </p>
          )}
          {preview.conflict && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  retainedSummaryText.current = preview.text;
                  await api.summary(preview.summary.discussionId);
                  dismissedSummaries.current.add(preview.summary.id);
                  setPreview(null);
                  await model.refresh();
                })
              }
            >
              重新整理，保留当前编辑内容
            </button>
          )}
          <div className="dialog-actions">
            <button className="outline" disabled={busy} onClick={closePreview}>
              暂不确认
            </button>
            <button
              className="primary"
              disabled={busy || !preview.text.trim() || preview.conflict}
              onClick={() => void confirm()}
            >
              {busy ? "正在保存…" : preview.error ? "重试保存" : "确认并保存"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
