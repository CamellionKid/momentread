import React, { useEffect, useRef, useState } from "react";
import {
  BookOpenIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CaretRightIcon,
  CaretDownIcon,
  FileTextIcon,
  PlusIcon,
  XIcon,
  ListIcon,
  TextAaIcon,
  GearSixIcon,
  CheckIcon,
  DownloadSimpleIcon,
  UploadSimpleIcon,
  MagnifyingGlassIcon,
  ArrowCounterClockwiseIcon,
  GitBranchIcon,
  DotsThreeIcon,
  WarningCircleIcon,
  LinkSimpleIcon,
  BookmarkSimpleIcon,
} from "@phosphor-icons/react";
import { paragraphs, books, initialNodes, ancestors, layoutTree } from "./data";
const Icon = ({ as: Component, size = 20, ...props }) => (
  <Component size={size} weight="light" aria-hidden="true" {...props} />
);
const IconButton = ({ icon, label, onClick, ...props }) => (
  <button
    className="icon-button"
    type="button"
    title={label}
    aria-label={label}
    onClick={onClick}
    {...props}
  >
    <Icon as={icon} />
  </button>
);
const summaryExcerpt = (text) => {
  const lines = String(text)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length > 1 && lines[0].startsWith("关于")
    ? lines[1]
    : lines[0] || "";
};
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector("input,textarea,button,select")?.focus();
    function key(e) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const els = [
          ...ref.current.querySelectorAll(
            "button:not(:disabled),input,textarea,select,a[href]",
          ),
        ];
        if (!els.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <IconButton icon={XIcon} label="关闭" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}
function RouteRail({ nodes, active, setActive, collapsed, visible }) {
  const { positions, height, width } = layoutTree(nodes, collapsed, active);
  const activeRef = useRef(null);
  const railRef = useRef(null);
  const [tip, setTip] = useState({ left: 0, top: 0 });
  const placeTip = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({
      left: Math.max(12, Math.min(window.innerWidth - 210, r.x - 85)),
      top: Math.max(8, r.y - 65),
    });
  };
  useEffect(() => {
    const reveal = () => {
      if (railRef.current?.clientWidth) {
        if (width <= railRef.current.clientWidth)
          railRef.current.scrollLeft = 0;
        activeRef.current?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [active, visible, width, height]);
  return (
    <aside ref={railRef} className="route-rail" aria-label="概念线路图">
      <div className="route-map" style={{ height, width }}>
        <svg
          width={width}
          height={height}
          aria-hidden="true"
          className="route-lines"
        >
          <path d={`M 32 5 V ${height - 45}`} />
          {positions
            .filter((n) => n.parent)
            .map((n) => {
              const p = positions.find((p) => p.id === n.parent);
              return p ? (
                <path
                  key={n.id}
                  d={`M ${p.x} ${p.y} H ${p.x + 14} Q ${p.x + 34} ${p.y} ${p.x + 34} ${p.y + (n.y > p.y ? 20 : -20)} V ${n.y + (n.y > p.y ? -20 : 20)} Q ${p.x + 34} ${n.y} ${p.x + 54} ${n.y} H ${n.x}`}
                />
              ) : null;
            })}
        </svg>
        {positions.map((n) => (
          <div
            key={n.id}
            className="route-point-wrap"
            onMouseEnter={placeTip}
            onFocus={placeTip}
            style={{ left: n.x, top: n.y }}
          >
            <button
              ref={n.id === active ? activeRef : null}
              className={`route-point ${n.id === active ? "active" : ""} ${n.folded ? "folded" : ""}`}
              aria-label={`${n.title}${n.returned ? "，已回馈" : ""}${n.needsUpdate ? "，有待合并更新" : ""}`}
              aria-current={n.id === active ? "true" : undefined}
              onClick={() => setActive(n.id)}
            >
              <span />
            </button>
            <div role="tooltip" className="node-tooltip" style={tip}>
              <strong>{n.title}</strong>
              <span>
                {n.returned ? "已回馈" : "讨论中"}
                {n.needsUpdate ? " · 待合并更新" : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
export function App() {
  const params = new URLSearchParams(location.search);
  const [screen, setScreen] = useState(params.get("screen") || "reader");
  const [nodes, setNodes] = useState(initialNodes);
  const [active, setActive] = useState("judgment");
  const [currentBook, setCurrentBook] = useState(books[0]);
  const [modal, setModal] = useState(null);
  const [collapsed, setCollapsed] = useState(new Set());
  const [fontSize, setFontSize] = useState(24);
  const [chapter, setChapter] = useState("经验与认识");
  const [progress, setProgress] = useState(12);
  const [highlightedParagraph, setHighlightedParagraph] = useState(1);
  const [toast, setToast] = useState("");
  const [selection, setSelection] = useState(null);
  const [branchText, setBranchText] = useState("");
  const [branchSource, setBranchSource] = useState("");
  const [matchStatus, setMatchStatus] = useState("unverified");
  const [candidate, setCandidate] = useState(null);
  const [connection, setConnection] = useState(true);
  const [generating, setGenerating] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryText, setSummaryText] = useState("");
  const [simulateSaveFailure, setSimulateSaveFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [importName, setImportName] = useState("");
  const [importError, setImportError] = useState("");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState(books);
  const [smallPanel, setSmallPanel] = useState("reading");
  const [bookWorkspaces, setBookWorkspaces] = useState({});
  const chatScroll = useRef(null);
  const readerScroll = useRef(null);
  const timer = useRef(null);
  const toastTimer = useRef(null);
  const messageCounter = useRef(0);
  const node = nodes.find((n) => n.id === active) || nodes[1];
  const path = ancestors(nodes, node.id);
  const parent = nodes.find((n) => n.id === node.parent);
  const confirmed = nodes.filter((n) => n.summary);
  const concepts = nodes.filter((n) => n.parent);
  const notify = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  };
  const patch = (id, values) =>
    setNodes((old) => old.map((n) => (n.id === id ? { ...n, ...values } : n)));
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(toastTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (chatScroll.current) chatScroll.current.scrollTop = node.scroll || 0;
  }, [active]);
  useEffect(() => {
    const nav = document.querySelector(".breadcrumbs");
    if (!nav) return;
    const reveal = () =>
      nav
        .querySelector("[aria-current=page]")
        ?.scrollIntoView({ block: "nearest", inline: "end" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active, smallPanel, screen]);
  const navigate = (id) => {
    if (chatScroll.current)
      patch(active, { scroll: chatScroll.current.scrollTop });
    setActive(id);
    setSelection(null);
    setSummary(null);
    setSmallPanel("discussion");
  };
  const changeScreen = (s) => {
    setScreen(s);
    setSelection(null);
    setModal(null);
  };
  function openBook(book) {
    if (generating) {
      notify("请先停止当前演示生成，再切换书籍。");
      return;
    }
    setBookWorkspaces((old) => ({
      ...old,
      [currentBook.id]: { nodes, active, progress, chapter, collapsed },
    }));
    if (book.id !== currentBook.id) {
      const saved = bookWorkspaces[book.id];
      setNodes(saved?.nodes || initialNodes());
      setActive(saved?.active || "passage");
      setProgress(saved?.progress ?? book.progress);
      setChapter(saved?.chapter || "经验与认识");
      setCollapsed(saved?.collapsed || new Set());
      setMatchStatus("unverified");
    }
    setCurrentBook(book);
    changeScreen("reader");
    setSmallPanel("reading");
  }
  function readSelection(e, kind) {
    const s = window.getSelection();
    const text = s?.toString().trim();
    if (
      !text ||
      !e.currentTarget.contains(s.anchorNode) ||
      !e.currentTarget.contains(s.focusNode)
    ) {
      setSelection(null);
      return;
    }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    setSelection({
      text,
      kind,
      x: Math.min(window.innerWidth - 270, Math.max(16, rect.left)),
      y: Math.min(window.innerHeight - 70, rect.bottom + 10),
    });
  }
  function openBranch(text = "", source = "") {
    setBranchText(text);
    setBranchSource(source || text || node.excerpt);
    setSelection(null);
    setModal("branch");
  }
  function createBranch() {
    if (!branchText.trim()) return;
    const title = branchText.trim();
    const id = `concept-${Date.now()}`;
    setNodes((old) => [
      ...old,
      {
        id,
        parent: active,
        kind: "concept",
        title,
        excerpt: branchSource || node.excerpt,
        messages: [],
        draft: "",
        returned: false,
        summary: null,
        summaryVersion: 0,
        needsUpdate: false,
        receipts: [],
        body: [
          [
            "在当前语境中",
            `你从“${node.title}”展开了“${title}”。这场独立讨论保留来源段落与父讨论背景。这里使用演示回复，让你先体验概念展开与返回。`,
          ],
          [
            "接下来可以问",
            "这个概念和相近概念有什么不同？它在当前段落中承担了什么作用？",
          ],
        ],
      },
    ]);
    setModal(null);
    setActive(id);
    setSmallPanel("discussion");
    notify(`已展开“${title}”，阅读位置保留`);
  }
  function analyze(text) {
    const at = paragraphs.findIndex((p) => p.includes(text));
    if (at >= 0) setHighlightedParagraph(at);
    const id = `passage-${Date.now()}`;
    setNodes((old) => [
      ...old,
      {
        id,
        parent: null,
        kind: "passage",
        title: "新的段落解析",
        excerpt: text,
        messages: [],
        draft: "",
        returned: false,
        summary: null,
        summaryVersion: 0,
        needsUpdate: false,
        receipts: [],
        body: [
          [
            "这段在说什么",
            "先把这段文字放回上下文，再区分其中的概念和论证关系。",
          ],
          [
            "内容拆解",
            "在演示中，你可以选中这段解析中的“概念”或“论证”，分别展开讨论。真实原著匹配与 AI 调用会在后续开发中接入。",
          ],
          [
            "举个例子",
            "把来源段落看作一条主线。遇到暂时不理解的词，可以沿支线探索，再带着小结回来。",
          ],
        ],
      },
    ]);
    setActive(id);
    setSelection(null);
    setSmallPanel("discussion");
    window.getSelection()?.removeAllRanges();
    notify("已创建段落解析 · 演示回复");
  }
  function send() {
    if (!node.draft.trim() || generating) return;
    if (!connection) {
      notify("AI 尚未连接，问题已保留。");
      return;
    }
    const id = active;
    const text = node.draft.trim();
    messageCounter.current++;
    patch(id, {
      draft: "",
      messages: [
        ...node.messages,
        { id: `u${messageCounter.current}`, role: "user", text },
      ],
    });
    setGenerating(id);
    timer.current = setTimeout(() => {
      setNodes((old) =>
        old.map((n) =>
          n.id === id
            ? {
                ...n,
                messages: [
                  ...n.messages,
                  {
                    id: `a${messageCounter.current}`,
                    role: "assistant",
                    text: `可以从“${n.title}”在这段话中的作用来理解。先明确它要回答的问题，再与相近概念比较；如果仍然不清楚，可以选中文字，展开另一场概念讨论。`,
                    demo: true,
                  },
                ],
              }
            : n,
        ),
      );
      setGenerating(null);
      setTimeout(() => {
        if (chatScroll.current && active === id)
          chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
      }, 50);
    }, 900);
  }
  function startSummary() {
    if (generating) {
      notify("请先停止生成，再整理小结。");
      return;
    }
    if (!connection) {
      notify("AI 尚未连接，讨论仍保留。");
      return;
    }
    setSaveError("");
    setSummary({ nodeId: active, stage: "loading" });
    setSummaryText("");
    timer.current = setTimeout(() => {
      const receipts = node.receipts || [];
      setSummaryText(
        `关于“${node.title}”\n\n${node.body[0][1]}\n\n${receipts.length ? `已结合 ${receipts.length} 份子讨论回馈。\n\n` : ""}仍待核对：原著术语、具体段落与适用语境。\n\n回到${parent ? `“${parent.title}”` : "阅读主线"}时，可以继续关注这个概念如何参与当前论证。`,
      );
      setSummary({ nodeId: active, stage: "preview" });
    }, 700);
  }
  function confirmSummary() {
    if (!summaryText.trim() || saving) return;
    setSaving(true);
    setSaveError("");
    const summaryNode = nodes.find((n) => n.id === summary.nodeId);
    timer.current = setTimeout(() => {
      if (simulateSaveFailure) {
        setSaveError("这次没有保存成功。编辑内容仍在，请重试。");
        setSaving(false);
        setSimulateSaveFailure(false);
        return;
      }
      const version = (summaryNode.summaryVersion || 0) + 1;
      setNodes((old) =>
        old.map((n) => {
          if (n.id === summaryNode.id)
            return {
              ...n,
              summary: summaryText,
              summaryVersion: version,
              returned: true,
              needsUpdate: false,
            };
          if (n.id === summaryNode.parent)
            return {
              ...n,
              receipts: [
                ...(n.receipts || []).filter(
                  (r) => r.nodeId !== summaryNode.id,
                ),
                {
                  nodeId: summaryNode.id,
                  title: summaryNode.title,
                  text: summaryText,
                  version,
                },
              ],
              needsUpdate: !!n.summary,
            };
          return n;
        }),
      );
      setSaving(false);
      setSummary(null);
      if (summaryNode.parent) setActive(summaryNode.parent);
      notify(
        summaryNode.parent
          ? `已保存小结，回到“${parent?.title || "上一级"}”`
          : "已保存段落小结",
      );
    }, 450);
  }
  function exportSummary() {
    const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MomentRead · 阅读小结</title><style>body{max-width:760px;margin:64px auto;padding:24px;color:#deded5;background:#191a18;font:18px/1.9 Georgia,"Songti SC",serif}h1{font-size:40px}section{border-top:1px solid #45473f;margin-top:32px;padding-top:20px}small{color:#a0a498}</style><small>MomentRead · 演示阅读记录 · 非原著引文</small><h1>今天，读懂了一点</h1><h2>${escapeHtml(currentBook.title)}</h2><p>当前进度 ${progress}% · ${escapeHtml(chapter)}</p><section><h2>确认的小结</h2>${confirmed.length ? confirmed.map((n) => `<h3>${escapeHtml(n.title)}</h3><p>${escapeHtml(n.summary).replace(/\n/g, "<br>")}</p>`).join("") : "<p>还没有确认小结。讨论内容不等于已掌握。</p>"}</section><section><h2>还想继续的问题</h2><p>这些概念在后文中是否保持相同的含义？原著段落仍待核对。</p></section><small>此文件用于回看，不是完整学习数据备份。</small></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([body], { type: "text/html;charset=utf-8" }),
    );
    a.download = "MomentRead-阅读小结-演示.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notify("HTML 已导出，可离线打开");
  }
  function importBook() {
    if (!importName) {
      setImportError("先选择一个 EPUB 文件。");
      return;
    }
    const book = {
      id: `book-${Date.now()}`,
      title: importName.replace(/\.epub$/i, ""),
      author: "作者待补充",
      chapter: "演示正文",
      progress: 0,
      discussions: 0,
    };
    setLibrary((old) => [...old, book]);
    setModal(null);
    notify("已加入演示书架，文件没有上传");
    openBook(book);
  }
  const closeModal = () => setModal(null);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="brand"
            onClick={() => changeScreen("library")}
            aria-label="返回书架"
          >
            <Icon as={BookOpenIcon} size={28} />
            <span>{screen === "reader" ? "精读" : "MomentRead"}</span>
          </button>
          <span className="top-divider" />
          <span className="top-book">
            {screen === "reader"
              ? currentBook.title
              : screen === "summary"
                ? "阅读小结"
                : "阅读与思考"}
          </span>
        </div>
        <div className="topbar-actions">
          <span className="demo-indicator">演示模式</span>
          {screen === "reader" && (
            <>
              <IconButton
                icon={ListIcon}
                label="目录"
                onClick={() => setModal("chapters")}
              />
              <IconButton
                icon={TextAaIcon}
                label="阅读设置"
                onClick={() => setModal("reading-settings")}
              />
            </>
          )}
          {screen === "library" && (
            <button
              className="outline small"
              onClick={() => setModal("import")}
            >
              <Icon as={PlusIcon} size={16} />
              导入 EPUB
            </button>
          )}
          {screen === "summary" ? (
            <button
              className="text-button"
              onClick={() => changeScreen("reader")}
            >
              <Icon as={ArrowLeftIcon} size={17} />
              回到阅读
            </button>
          ) : (
            <button
              className="text-button"
              onClick={() => changeScreen("summary")}
            >
              <Icon as={FileTextIcon} size={18} />
              今日小结
            </button>
          )}
          <IconButton
            icon={GearSixIcon}
            label="连接与原型场景"
            onClick={() => setModal("settings")}
          />
        </div>
      </header>
      {screen === "reader" && (
        <>
          <nav className="compact-tabs">
            <button
              className={smallPanel === "reading" ? "selected" : ""}
              onClick={() => setSmallPanel("reading")}
            >
              阅读正文
            </button>
            <button
              className={smallPanel === "discussion" ? "selected" : ""}
              onClick={() => setSmallPanel("discussion")}
            >
              概念讨论
            </button>
          </nav>
          <main className={`workspace show-${smallPanel}`}>
            <section className="reader-panel" aria-label="书籍正文">
              <div
                ref={readerScroll}
                className="reader-content"
                onMouseUp={(e) => readSelection(e, "passage")}
                style={{ "--reading-font": `${fontSize}px` }}
              >
                <div className="eyebrow">绪论</div>
                <h1>{chapter}</h1>
                <p className="source-label">演示文本 · 非原著引文</p>
                <div className="book-prose">
                  {paragraphs.map((p, i) => (
                    <p
                      key={i}
                      id={`paragraph-${i}`}
                      className={
                        i === highlightedParagraph ? "selected-paragraph" : ""
                      }
                    >
                      {p}
                    </p>
                  ))}
                </div>
                <button
                  className="text-button analyze-default"
                  onClick={() => analyze(paragraphs[highlightedParagraph])}
                >
                  <Icon as={PlusIcon} size={16} />
                  解析选中段落
                </button>
              </div>
              <footer className="reading-progress">
                <input
                  type="range"
                  min="0"
                  max="100"
                  aria-label="阅读进度"
                  value={progress}
                  onChange={(e) => setProgress(Number(e.target.value))}
                />
                <span>位置 {progress}%</span>
              </footer>
            </section>
            <section className="discussion-panel" aria-label="AI 讨论">
              <div className="discussion-top">
                <nav className="breadcrumbs" aria-label="讨论路径">
                  {path.map((n, i) => (
                    <React.Fragment key={n.id}>
                      {i > 0 && <Icon as={CaretRightIcon} size={14} />}
                      <button
                        onClick={() => navigate(n.id)}
                        aria-current={n.id === active ? "page" : undefined}
                      >
                        {n.title}
                      </button>
                    </React.Fragment>
                  ))}
                </nav>
                <div className="discussion-title">
                  <h1>{node.title}</h1>
                  <IconButton
                    icon={DotsThreeIcon}
                    label="讨论操作"
                    onClick={() => setModal("discussion-actions")}
                  />
                </div>
                <div className="discussion-subtitle">
                  {node.parent
                    ? path.length > 2
                      ? "子概念讨论"
                      : "概念讨论"
                    : "选段解析"}
                  {node.returned && (
                    <span className="status-word">
                      <Icon as={CheckIcon} size={13} />
                      已回馈
                    </span>
                  )}
                </div>
              </div>
              <div
                ref={chatScroll}
                className="discussion-scroll"
                onScroll={(e) => {
                  node.scroll = e.currentTarget.scrollTop;
                }}
              >
                <blockquote className="source-quote">
                  <p>{node.excerpt}</p>
                  <button onClick={() => setModal("sources")}>
                    原文
                    {matchStatus === "candidate"
                      ? "有多个候选"
                      : matchStatus === "unavailable"
                        ? "未找到"
                        : "待核"}
                    <Icon as={CaretRightIcon} size={12} />
                  </button>
                </blockquote>
                {!connection && (
                  <div className="notice">
                    <Icon as={WarningCircleIcon} />
                    <div>
                      AI 暂未连接<p>可以继续阅读，现有讨论与草稿会保留。</p>
                      <button
                        className="text-button"
                        onClick={() => setModal("settings")}
                      >
                        查看连接
                      </button>
                    </div>
                  </div>
                )}
                {node.needsUpdate && (
                  <div className="notice">
                    子讨论有新的小结，重新整理时可合并更新。
                  </div>
                )}
                {(node.receipts || []).length > 0 && (
                  <details className="returned-notes">
                    <summary>
                      <Icon as={CheckIcon} size={16} />
                      {node.receipts.length} 份子讨论小结已带回
                      <Icon as={CaretDownIcon} size={14} />
                    </summary>
                    {node.receipts.map((r) => (
                      <div key={r.nodeId}>
                        <button
                          className="text-button"
                          onClick={() => navigate(r.nodeId)}
                        >
                          {r.title}
                          <Icon as={CaretRightIcon} size={13} />
                        </button>
                        <p>{summaryExcerpt(r.text)}</p>
                      </div>
                    ))}
                  </details>
                )}
                <article
                  className="ai-answer"
                  onMouseUp={(e) => readSelection(e, "concept")}
                >
                  {node.body.map(([title, text]) => (
                    <section key={title}>
                      <h2>{title}</h2>
                      <p>{text}</p>
                    </section>
                  ))}
                </article>
                <div className="answer-actions">
                  <button className="text-button" onClick={() => openBranch()}>
                    <Icon as={GitBranchIcon} size={17} />
                    展开概念
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setModal("memory")}
                  >
                    <Icon as={BookmarkSimpleIcon} size={16} />
                    书内概念
                  </button>
                </div>
                {node.messages.map((m) => (
                  <div className={`message ${m.role}`} key={m.id}>
                    <small>{m.role === "user" ? "你" : "演示回复"}</small>
                    <p
                      onMouseUp={(e) =>
                        m.role === "assistant" && readSelection(e, "concept")
                      }
                    >
                      {m.text}
                    </p>
                  </div>
                ))}
                {generating === active && (
                  <div className="generating" role="status">
                    正在组织解释<span>…</span>
                  </div>
                )}
              </div>
              <footer className="composer">
                <div className="composer-row">
                  <div className="input-wrap">
                    <textarea
                      aria-label="继续追问"
                      placeholder="继续追问这个概念…"
                      value={node.draft}
                      onChange={(e) => patch(active, { draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    {node.draft && (
                      <IconButton
                        icon={ArrowUpIcon}
                        label="发送问题"
                        onClick={send}
                        disabled={!!generating}
                      />
                    )}
                  </div>
                  <button
                    className="primary return-button"
                    onClick={startSummary}
                    disabled={!!generating}
                  >
                    {node.parent ? "整理并返回" : "整理这段"}
                  </button>
                </div>
                <div className="composer-meta">
                  {parent ? (
                    <button onClick={() => navigate(parent.id)}>
                      返回上一级：{parent.title}
                    </button>
                  ) : (
                    <span>选中文字，可以展开概念</span>
                  )}
                  {generating === active ? (
                    <button
                      onClick={() => {
                        clearTimeout(timer.current);
                        setGenerating(null);
                        notify("已停止生成，问题仍保留");
                      }}
                    >
                      停止生成
                    </button>
                  ) : (
                    <span>讨论已保留</span>
                  )}
                </div>
              </footer>
            </section>
            <RouteRail
              nodes={nodes}
              active={active}
              setActive={navigate}
              collapsed={collapsed}
              visible={smallPanel}
            />
          </main>
        </>
      )}
      {screen === "library" && (
        <main className="library-page">
          <div className="page-heading">
            <p className="eyebrow">你的阅读空间</p>
            <h1>回到书里</h1>
            <p>让不懂的地方，有处可去。</p>
          </div>
          <div className="library-layout">
            <section>
              <div className="list-heading">
                <span>
                  书架{" "}
                  <small>{library.length.toString().padStart(2, "0")}</small>
                </span>
                <label className="search-input">
                  <Icon as={MagnifyingGlassIcon} size={18} />
                  <input
                    aria-label="搜索书籍"
                    placeholder="找一本书"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              {library
                .filter((b) => b.title.includes(query))
                .map((book, i) => (
                  <article
                    className={`book-row ${i === 0 ? "featured" : ""}`}
                    key={book.id}
                  >
                    <div className="book-number">
                      {(i + 1).toString().padStart(2, "0")}
                    </div>
                    <div className="book-row-body">
                      <span className="author">{book.author}</span>
                      <button
                        className="book-title"
                        onClick={() => openBook(book)}
                      >
                        {book.title}
                      </button>
                      <p>{book.chapter}</p>
                      <div className="book-row-foot">
                        <span>
                          {book.id === currentBook.id
                            ? progress
                            : book.progress}
                          %<span className="dot-separator">·</span>
                          {book.progress ? "阅读进行中" : "尚未开始"}
                        </span>
                        <button
                          className={i === 0 ? "primary" : "text-button"}
                          onClick={() => openBook(book)}
                        >
                          {book.progress ? "继续阅读" : "打开书籍"}
                          <Icon as={ArrowRightIcon} size={17} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              {library.filter((b) => b.title.includes(query)).length === 0 && (
                <div className="empty-state">
                  <h3>还没有找到这本书</h3>
                  <p>换一个书名，或导入新的 EPUB。</p>
                  <button
                    className="outline"
                    onClick={() => setModal("import")}
                  >
                    导入 EPUB
                  </button>
                </div>
              )}
              <p className="quiet-note">
                演示书架 · 书籍与阅读记录仅用于体验设计
              </p>
            </section>
            <aside className="resume-aside">
              <span className="eyebrow">上次停在这里</span>
              <h2>理解，不必一口气完成。</h2>
              <p>你正在「{node.title}」的讨论中。回到那条思路，再读一小段。</p>
              <button
                className="text-button"
                onClick={() => {
                  changeScreen("reader");
                  navigate(active);
                }}
              >
                回到「{node.title}」<Icon as={ArrowRightIcon} size={17} />
              </button>
              <div className="aside-rule" />
              <span className="eyebrow">这本书的思考</span>
              <button className="aside-row" onClick={() => setModal("memory")}>
                概念与不同用法
                <Icon as={CaretRightIcon} size={16} />
              </button>
              <button
                className="aside-row"
                onClick={() => changeScreen("summary")}
              >
                今日阅读小结
                <Icon as={CaretRightIcon} size={16} />
              </button>
            </aside>
          </div>
        </main>
      )}
      {screen === "summary" && (
        <main className="summary-page">
          <div className="summary-heading">
            <span className="eyebrow">MomentRead · 演示阅读记录</span>
            <h1>今天，读懂了一点</h1>
            <p>把走过的思路留下，下次不必从头开始。</p>
          </div>
          <div className="summary-book">
            <div>
              <span className="eyebrow">本次阅读</span>
              <h2>{currentBook.title}</h2>
              <p>
                绪论 · {chapter} <span className="dot-separator">/</span>
                当前位置 {progress}%
              </p>
            </div>
            <button className="outline" onClick={exportSummary}>
              <Icon as={DownloadSimpleIcon} size={18} />
              导出 HTML
            </button>
          </div>
          <div className="reading-facts">
            <div>
              <strong>{nodes.filter((n) => !n.parent).length}</strong>
              <span>段落解析</span>
            </div>
            <div>
              <strong>{concepts.length}</strong>
              <span>概念讨论</span>
            </div>
            <div>
              <strong>{confirmed.length}</strong>
              <span>确认小结</span>
            </div>
          </div>
          <section className="summary-section">
            <div className="section-label">
              01<span>澄清了什么</span>
            </div>
            <div>
              {confirmed.length ? (
                confirmed.map((n) => (
                  <article className="summary-note" key={n.id}>
                    <button
                      onClick={() => {
                        changeScreen("reader");
                        navigate(n.id);
                      }}
                    >
                      {n.title}
                      <Icon as={ArrowRightIcon} size={17} />
                    </button>
                    <p>{summaryExcerpt(n.summary)}</p>
                    <small>
                      已确认小结 · 原文待核 · 版本 {n.summaryVersion}
                    </small>
                  </article>
                ))
              ) : (
                <div className="summary-note">
                  <h3>思考已经开始，结论还可以慢慢来。</h3>
                  <p>
                    你展开了{concepts.length}
                    场概念讨论。整理并确认一份小结，它就会出现在这里。
                  </p>
                  <button
                    className="text-button"
                    onClick={() => changeScreen("reader")}
                  >
                    继续这场讨论
                    <Icon as={ArrowRightIcon} size={17} />
                  </button>
                </div>
              )}
            </div>
          </section>
          <section className="summary-section">
            <div className="section-label">
              02<span>还想继续的问题</span>
            </div>
            <div className="summary-note">
              <h3>相同的词，在后文中还是相同的意思吗？</h3>
              <p>
                继续阅读时，留意概念出现的语境。原著段落仍待核对，暂时保留这份不确定。
              </p>
            </div>
          </section>
          <footer className="summary-return">
            <div>
              <span className="eyebrow">下次，从这里继续</span>
              <p>绪论 · {chapter}</p>
            </div>
            <button className="primary" onClick={() => changeScreen("reader")}>
              回到阅读
              <Icon as={ArrowRightIcon} size={17} />
            </button>
          </footer>
          <p className="quiet-note">
            讨论、确认小结与掌握知识是不同的事。这里不计算掌握率。
          </p>
        </main>
      )}
      {selection && !modal && !summary && (
        <div
          className="selection-toolbar"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            onClick={() =>
              selection.kind === "passage"
                ? analyze(selection.text)
                : openBranch(selection.text, selection.text)
            }
          >
            <Icon
              as={selection.kind === "passage" ? PlusIcon : GitBranchIcon}
              size={17}
            />
            {selection.kind === "passage" ? "解析一下" : "展开概念"}
          </button>
          <IconButton
            icon={XIcon}
            label="关闭选区操作"
            onClick={() => setSelection(null)}
          />
        </div>
      )}
      {modal === "branch" && (
        <Dialog title="展开一个概念" onClose={closeModal}>
          <p className="dialog-intro">
            从「{node.title}」继续深入。当前讨论与阅读位置会为你保留。
          </p>
          <label className="field-label">
            想澄清的概念
            <input
              autoComplete="off"
              autoFocus
              placeholder="例如：判断、先天、普遍性"
              value={branchText}
              onChange={(e) => setBranchText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createBranch()}
            />
          </label>
          <blockquote className="dialog-quote">{branchSource}</blockquote>
          <p className="quiet-note">
            新分支只接续这条思路，同级概念保留各自的讨论。
          </p>
          <footer className="dialog-actions">
            <button className="text-button" onClick={closeModal}>
              留在这里
            </button>
            <button
              className="primary"
              disabled={!branchText.trim()}
              onClick={createBranch}
            >
              展开概念
              <Icon as={ArrowRightIcon} size={17} />
            </button>
          </footer>
        </Dialog>
      )}
      {summary && (
        <Dialog
          title={summary.stage === "loading" ? "整理这场讨论" : "把理解带回去"}
          wide
          onClose={() => {
            clearTimeout(timer.current);
            setSummary(null);
            setSaving(false);
          }}
        >
          {summary.stage === "loading" ? (
            <div className="loading-state" role="status">
              <p>正在回看这条思路…</p>
              <span>整理结论、出处与还没解决的问题</span>
            </div>
          ) : (
            <>
              <p className="dialog-intro">
                「{node.title}」的小结将
                {parent ? `带回「${parent.title}」` : "保存在当前段落"}
                。确认前，可以改成你自己的表达。
              </p>
              <label className="field-label">
                讨论小结
                <textarea
                  className="summary-editor"
                  aria-label="编辑讨论小结"
                  value={summaryText}
                  onChange={(e) => setSummaryText(e.target.value)}
                />
              </label>
              {nodes.some((n) => n.parent === active && !n.returned) && (
                <p className="notice">
                  还有未整理的子讨论，会作为待续问题保留。
                </p>
              )}
              {saveError && (
                <p className="error-message" role="alert">
                  {saveError}
                </p>
              )}
              <div className="summary-preview-source">
                <span>来源：{path.map((n) => n.title).join(" / ")}</span>
                <span>原文待核</span>
              </div>
              <footer className="dialog-actions">
                <button
                  className="text-button"
                  onClick={() => setSummary(null)}
                  disabled={saving}
                >
                  继续讨论
                </button>
                <button
                  className="primary"
                  onClick={confirmSummary}
                  disabled={saving || !summaryText.trim()}
                >
                  {saving
                    ? "正在保存…"
                    : parent
                      ? "确认并返回上一级"
                      : "确认小结"}
                  {!saving && <Icon as={ArrowRightIcon} size={17} />}
                </button>
              </footer>
            </>
          )}
        </Dialog>
      )}
      {modal === "import" && (
        <Dialog title="把一本书带进来" onClose={closeModal}>
          <p className="dialog-intro">
            导入可选中文字的 EPUB，开始一场可以慢慢接续的阅读。
          </p>
          <label className="import-zone">
            <Icon as={UploadSimpleIcon} size={32} />
            <strong>{importName || "选择 EPUB 文件"}</strong>
            <span>文件保留在你的电脑上</span>
            <input
              type="file"
              accept=".epub"
              aria-label="选择 EPUB 文件"
              onChange={(e) => {
                const f = e.target.files[0];
                if (f && !f.name.toLowerCase().endsWith(".epub")) {
                  setImportError("请选择 .epub 格式的书籍。");
                  return;
                }
                setImportName(f?.name || "");
                setImportError("");
              }}
            />
          </label>
          {importError && (
            <p className="error-message" role="alert">
              {importError}
            </p>
          )}
          <p className="quiet-note">
            设计预览：文件不会上传，打开后使用演示正文。
          </p>
          <footer className="dialog-actions">
            <button className="text-button" onClick={closeModal}>
              稍后再说
            </button>
            <button className="primary" onClick={importBook}>
              加入书架
              <Icon as={ArrowRightIcon} size={17} />
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "chapters" && (
        <Dialog title="目录" onClose={closeModal}>
          {["经验与认识", "先天知识的可能性", "纯粹理性的任务"].map((c, i) => (
            <button
              key={c}
              className="chapter-row"
              onClick={() => {
                setChapter(c);
                setProgress(12 + i * 8);
                readerScroll.current?.scrollTo(0, 0);
                closeModal();
                notify("已切换章节标题 · 正文为演示文本");
              }}
            >
              <span>
                <small>0{i + 1}</small>
                {c}
              </span>
              {chapter === c ? (
                <Icon as={CheckIcon} />
              ) : (
                <Icon as={CaretRightIcon} />
              )}
            </button>
          ))}
        </Dialog>
      )}
      {modal === "reading-settings" && (
        <Dialog title="阅读，按你的节奏" onClose={closeModal}>
          <div className="setting-row">
            <label htmlFor="font-size">正文字号</label>
            <span>{fontSize}px</span>
          </div>
          <input
            id="font-size"
            className="full-range"
            type="range"
            min="18"
            max="30"
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <div className="font-preview" style={{ fontSize }}>
            让思考在字里行间，慢慢展开。
          </div>
          <p className="quiet-note">深色阅读 · 宋体正文 · 左右独立滚动</p>
          <footer className="dialog-actions">
            <button className="text-button" onClick={() => setFontSize(24)}>
              恢复默认
            </button>
            <button className="primary" onClick={closeModal}>
              继续阅读
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "sources" && (
        <Dialog title="原文与来源" onClose={closeModal}>
          <p className="dialog-intro">对照原著之前，先保留来源的不确定。</p>
          <div className="source-detail">
            <span className="eyebrow">中文选段</span>
            <p>{path[0]?.excerpt || node.excerpt}</p>
            <button
              className="text-button"
              onClick={() => {
                closeModal();
                setSmallPanel("reading");
                const at = paragraphs.findIndex((p) =>
                  p.includes(path[0]?.excerpt || node.excerpt),
                );
                setHighlightedParagraph(at >= 0 ? at : 1);
                readerScroll.current
                  ?.querySelector(`#paragraph-${at >= 0 ? at : 1}`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
                notify("已定位到演示选段");
              }}
            >
              定位原文
              <Icon as={ArrowRightIcon} size={16} />
            </button>
          </div>
          {matchStatus === "candidate" ? (
            <div className="candidates">
              <h3>找到两条待核对线索</h3>
              <p>演示候选，不含未经核对的外文引句。</p>
              {["德语文本 · 绪论相关段落", "另一版本 · 章节划分不同"].map(
                (c, i) => (
                  <label key={c}>
                    <input
                      type="radio"
                      name="candidate"
                      checked={candidate === i}
                      onChange={() => setCandidate(i)}
                    />
                    <span>
                      {c}
                      <small>版本和段落对应关系待核</small>
                    </span>
                  </label>
                ),
              )}
              <button
                className="outline"
                disabled={candidate === null}
                onClick={() => {
                  notify("已保留候选线索，仍标记为待核");
                  closeModal();
                }}
              >
                保留这条线索
              </button>
            </div>
          ) : (
            <div className="empty-source">
              <Icon as={LinkSimpleIcon} size={24} />
              <h3>
                {matchStatus === "unavailable"
                  ? "暂时没有找到可靠原文"
                  : "这段原文还待核对"}
              </h3>
              <p>
                可以继续理解中文，也可以补充原著。AI
                重译不等于已经找到作者原文。
              </p>
              <button
                className="outline"
                onClick={() => setModal("original-import")}
              >
                补充原著文件
              </button>
            </div>
          )}
        </Dialog>
      )}
      {modal === "original-import" && (
        <Dialog title="补充原著" onClose={closeModal}>
          <p className="dialog-intro">原著文件有助于更准确地核对段落与术语。</p>
          <label className="import-zone">
            <Icon as={UploadSimpleIcon} size={30} />
            <strong>选择原著文件</strong>
            <input
              type="file"
              accept=".epub,.txt,.pdf"
              onChange={(e) => {
                if (e.target.files[0]) {
                  notify("已演示补充原著；匹配状态仍待核");
                  closeModal();
                }
              }}
            />
          </label>
          <p className="quiet-note">设计预览不读取或上传文件正文。</p>
        </Dialog>
      )}
      {modal === "memory" && (
        <Dialog title="这本书里的概念" wide onClose={closeModal}>
          <p className="dialog-intro">
            同一个词，可以保留不同的用法。讨论过，不等于已经形成结论。
          </p>
          <div className="memory-tabs">
            <span>全部概念 {concepts.length}</span>
            <small>仅当前书籍</small>
          </div>
          {concepts.map((n) => (
            <button
              key={n.id}
              className="memory-row"
              onClick={() => {
                closeModal();
                changeScreen("reader");
                navigate(n.id);
              }}
            >
              <div>
                <strong>{n.title}</strong>
                <p>
                  {ancestors(nodes, n.id)
                    .slice(0, -1)
                    .map((p) => p.title)
                    .join(" / ")}
                </p>
              </div>
              <span>
                {n.summary ? "已确认小结" : "讨论中"}
                <Icon as={CaretRightIcon} size={16} />
              </span>
            </button>
          ))}
          <div className="notice">
            “理性”等同名词的不同义项将在真实文本核对后分别保存，演示不会自动合并它们。
          </div>
        </Dialog>
      )}
      {modal === "settings" && (
        <Dialog title="连接与体验场景" onClose={closeModal}>
          <p className="dialog-intro">
            这是交互设计原型。下列设置用于查看不同状态，不会调用真实 AI。
          </p>
          <div className="setting-row">
            <div>
              <strong>AI 演示连接</strong>
              <p>
                {connection ? "可体验模拟回复" : "断开时仍可阅读和编辑草稿"}
              </p>
            </div>
            <button
              className={`switch ${connection ? "on" : ""}`}
              role="switch"
              aria-checked={connection}
              aria-label="AI 演示连接"
              onClick={() => setConnection(!connection)}
            >
              <span />
            </button>
          </div>
          <label className="field-label">
            原著匹配状态
            <select
              value={matchStatus}
              onChange={(e) => setMatchStatus(e.target.value)}
            >
              <option value="unverified">原文待核</option>
              <option value="unavailable">没有找到可靠原文</option>
              <option value="candidate">有多个候选段落</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={simulateSaveFailure}
              onChange={(e) => setSimulateSaveFailure(e.target.checked)}
            />
            下一次确认小结时，演示保存失败
          </label>
          <p className="quiet-note">
            刷新页面会重置演示数据；真实数据保存将在后续开发中接入。
          </p>
          <footer className="dialog-actions">
            <button
              className="text-button"
              onClick={() => {
                clearTimeout(timer.current);
                setNodes(initialNodes());
                setActive("judgment");
                setGenerating(null);
                setProgress(12);
                setCollapsed(new Set());
                setSummary(null);
                closeModal();
                notify("已恢复初始演示");
              }}
            >
              <Icon as={ArrowCounterClockwiseIcon} size={16} />
              重置演示
            </button>
            <button className="primary" onClick={closeModal}>
              完成
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "discussion-actions" && (
        <Dialog title="讨论操作" onClose={closeModal}>
          <button
            className="chapter-row"
            onClick={() => {
              closeModal();
              openBranch();
            }}
          >
            展开子概念
            <Icon as={GitBranchIcon} />
          </button>
          <button
            className="chapter-row"
            onClick={() => {
              closeModal();
              startSummary();
            }}
          >
            {node.summary ? "重新整理小结" : "整理当前讨论"}
            <Icon as={FileTextIcon} />
          </button>
          <button
            className="chapter-row"
            onClick={() => {
              setCollapsed(
                new Set(
                  nodes
                    .filter((n) => n.parent && n.id !== active)
                    .map((n) => n.id),
                ),
              );
              closeModal();
            }}
          >
            收起其他概念分支
            <Icon as={CaretDownIcon} />
          </button>
          <button
            className="chapter-row"
            onClick={() => {
              setCollapsed(new Set());
              closeModal();
            }}
          >
            展开所有分支
            <Icon as={GitBranchIcon} />
          </button>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon as={CheckIcon} size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
