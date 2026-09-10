import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CaretRight,
  DotsThree,
  GitBranch,
  ArrowCounterClockwise,
  MapPin,
  Stop,
} from "@phosphor-icons/react";
import type {
  BookState,
  Discussion,
  Message,
  SummaryVersion,
} from "../../shared/contracts";
import {
  ancestry,
  isActiveRun,
  rootSources,
  runLabel,
  selectedMessageOrigin,
} from "./model";
import { Markdown } from "./Markdown";
export type BranchSelection = {
  visibleText: string;
  parentId: string;
  origin: { messageId: string; start: number; end: number; exact: string };
};
interface Props {
  state: BookState;
  node: Discussion | null;
  saveStatus: string;
  onDraft: (id: string, text: string) => void;
  onScroll: (id: string, scrollTop: number) => void;
  onSend: () => void;
  onSummary: () => void;
  onSelect: (id: string) => void;
  onBranch: (selection: BranchSelection) => void;
  onSources: () => void;
  onHistory: () => void;
  onConcepts: () => void;
  onLocate: () => void;
  onCancel: (id: string) => void;
  onAncestors: () => void;
  onCollapse: () => void;
  onExpand: () => void;
  onPreview: (summary: SummaryVersion) => void;
  onRetrySave: () => void;
}
export function DiscussionPane(props: Props) {
  const { state, node } = props;
  const scroll = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<BranchSelection | null>(null);
  const [menu, setMenu] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const path = ancestry(state.discussions, node?.id ?? null);
  const messages = state.messages.filter((m) => m.discussionId === node?.id);
  const activeRun = state.runs
    .filter((r) => r.discussionId === node?.id && isActiveRun(r))
    .at(-1);
  const lastRun = state.runs
    .filter((r) => r.discussionId === node?.id && r.purpose !== "daily")
    .at(-1);
  const root = state.discussions.find((d) => d.id === node?.rootId);
  const sources = rootSources(state, node);
  const pending = state.summaries
    .filter((s) => s.discussionId === node?.id && !s.confirmed)
    .at(-1);
  const receipts = state.receipts.filter((r) => r.parentId === node?.id);
  const rememberedScroll = useRef(0);
  const hydrating = useRef(false);
  useLayoutEffect(() => {
    setSelection(null);
    setSelectionError("");
    setMenu(false);
    hydrating.current = true;
    if (scroll.current) scroll.current.scrollTop = node?.scrollTop ?? 0;
    rememberedScroll.current = node?.scrollTop ?? 0;
    queueMicrotask(() => {
      hydrating.current = false;
    });
  }, [node?.id]);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && activeRun?.purpose === "discussion")
      el.scrollTop = el.scrollHeight;
  }, [activeRun?.partialText]);
  const selectMessage = (message: Message, element: HTMLElement) => {
    if (message.role !== "assistant" || message.status !== "complete") return;
    setSelectionError("");
    try {
      const origin = selectedMessageOrigin(
        element,
        message,
        window.getSelection(),
      );
      if (origin && node)
        setSelection({
          parentId: node.id,
          origin,
          visibleText: window.getSelection()?.toString() ?? "",
        });
      else setSelection(null);
    } catch (error) {
      setSelection(null);
      setSelectionError((error as Error).message);
    }
  };
  if (!node)
    return (
      <section className="discussion-panel">
        <div className="product-discussion-empty">
          <GitBranch size={36} weight="light" />
          <h1>让疑问有自己的去处。</h1>
          <p>在左侧正文里选中文字，点击「解析一下」。</p>
          <p className="quiet-note">
            AI
            会尝试寻找原著依据，再拆解内容、解释概念和举例。新的概念可以继续展开。
          </p>
        </div>
      </section>
    );
  return (
    <section className="discussion-panel" aria-label="AI 讨论">
      <div className="discussion-top">
        <nav className="breadcrumbs" aria-label="当前讨论路径">
          {path.length > 3 && (
            <>
              <button aria-label="查看完整祖先路径" onClick={props.onAncestors}>
                …
              </button>
              <CaretRight size={12} />
            </>
          )}
          {path.slice(-3).map((item, index) => (
            <span className="product-crumb" key={item.id}>
              {index > 0 && <CaretRight size={12} />}
              <button
                aria-current={item.id === node.id ? "page" : undefined}
                onClick={() => props.onSelect(item.id)}
              >
                {item.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="discussion-title">
          <h1>{node.title}</h1>
          <button
            className="icon-button"
            aria-label="讨论操作"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <DotsThree size={23} />
          </button>
        </div>
        <div className="discussion-subtitle">
          <span>{node.parentId ? "概念讨论" : "选段解析"}</span>
          <span className="status-word">
            {activeRun
              ? runLabel(activeRun)
              : node.needsMerge
                ? "待合并更新"
                : "独立讨论"}
          </span>
        </div>
        {menu && (
          <div className="product-discussion-menu">
            <button
              onClick={() => {
                setMenu(false);
                props.onHistory();
              }}
            >
              查看小结历史
            </button>
            <button
              onClick={() => {
                setMenu(false);
                props.onConcepts();
              }}
            >
              本书概念档案
            </button>
            <button
              onClick={() => {
                setMenu(false);
                props.onCollapse();
              }}
            >
              折叠其他分支
            </button>
            <button
              onClick={() => {
                setMenu(false);
                props.onExpand();
              }}
            >
              展开全部分支
            </button>
            <button
              onClick={() => {
                setMenu(false);
                props.onAncestors();
              }}
            >
              完整祖先路径
            </button>
          </div>
        )}
      </div>
      <div
        className="discussion-scroll"
        ref={scroll}
        onScroll={() => {
          if (
            !hydrating.current &&
            scroll.current &&
            Math.abs(scroll.current.scrollTop - rememberedScroll.current) > 3
          ) {
            rememberedScroll.current = scroll.current.scrollTop;
            props.onScroll(node.id, scroll.current.scrollTop);
          }
        }}
      >
        <div className="source-quote">
          <p>
            {node.origin?.exact ??
              root?.source?.segments.map((s) => s.exact).join("\n\n") ??
              ""}
          </p>
          <button onClick={props.onLocate}>
            <MapPin size={14} /> 定位正文选段
          </button>
        </div>
        <button className="product-source-status" onClick={props.onSources}>
          {sources.some((s) => s.verification === "confirmed")
            ? "已有核对的原著依据"
            : sources.length
              ? "原著候选待核对"
              : "原著尚未核对"}{" "}
          <CaretRight size={13} />
        </button>
        {node.needsMerge && (
          <div className="notice">
            <p>子讨论或来源有更新；重新整理时会纳入最新依据。</p>
          </div>
        )}
        {pending && (
          <div className="notice">
            <button
              className="text-button"
              onClick={() => props.onPreview(pending)}
            >
              有一份小结等待你确认 <ArrowRightSmall />
            </button>
          </div>
        )}
        {receipts.length > 0 && (
          <details className="returned-notes">
            <summary>
              <ArrowCounterClockwise size={16} /> {receipts.length} 条子讨论回馈
            </summary>
            {receipts.map((receipt) => {
              const summary = state.summaries.find(
                (s) => s.id === receipt.summaryId,
              );
              const child = state.discussions.find(
                (d) => d.id === receipt.childId,
              );
              return (
                <div key={receipt.id}>
                  <button
                    className="text-button"
                    onClick={() => props.onSelect(receipt.childId)}
                  >
                    {child?.title || "子讨论"} · 版本 {receipt.version}
                  </button>
                  {summary && <Markdown text={summary.content} />}
                </div>
              );
            })}
          </details>
        )}
        {messages.map((message) => (
          <article
            className={`message ${message.role} product-message`}
            key={message.id}
          >
            <small>
              {message.role === "user" ? "你" : "AI"}
              {message.status !== "complete" &&
                ` · ${message.status === "interrupted" ? "已中断" : message.status === "failed" ? "未完成" : "生成中"}`}
            </small>
            <div
              className="product-message-text"
              onMouseUp={(e) => selectMessage(message, e.currentTarget)}
              onKeyUp={(e) => {
                if (e.key === "Shift") selectMessage(message, e.currentTarget);
              }}
              tabIndex={message.role === "assistant" ? 0 : undefined}
            >
              {message.role === "assistant" ? (
                <Markdown text={message.text} />
              ) : (
                message.text
              )}
            </div>
            {message.role === "assistant" && message.status === "complete" && (
              <div className="answer-actions">
                <button
                  className="text-button"
                  disabled={selection?.origin.messageId !== message.id}
                  onClick={() => {
                    if (selection) props.onBranch(selection);
                  }}
                >
                  <GitBranch size={16} /> 展开选中的概念
                </button>
                <span
                  className="quiet-note"
                  role={selectionError ? "status" : undefined}
                >
                  {selectionError || "先在回答中选中文字"}
                </span>
              </div>
            )}
          </article>
        ))}
        {activeRun && (
          <div className="product-run-status" role="status">
            <span className="generating">{runLabel(activeRun)}…</span>
            {activeRun.purpose === "discussion" && activeRun.partialText && (
              <div className="product-message-text">
                <Markdown text={activeRun.partialText} />
              </div>
            )}
            <button
              className="text-button"
              onClick={() => props.onCancel(activeRun.id)}
            >
              <Stop size={14} /> 停止生成
            </button>
          </div>
        )}
        {lastRun &&
          !isActiveRun(lastRun) &&
          ["failed", "interrupted", "cancelled"].includes(lastRun.status) && (
            <div className="notice product-run-error" role="status">
              <p>{lastRun.error || "这次生成未完成，已保存的内容仍保留。"}</p>
              <small>可以在下方重新提问，或重新整理。</small>
            </div>
          )}
        {!messages.length && !activeRun && (
          <p className="quiet-note">讨论已建立，可以在下方提问。</p>
        )}
      </div>
      <div className="composer">
        <div className="composer-row">
          <div className="input-wrap">
            <textarea
              aria-label="继续提问"
              placeholder="继续提问…"
              value={node.draft}
              onChange={(e) => props.onDraft(node.id, e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.metaKey || e.ctrlKey) &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  props.onSend();
                }
              }}
            />
            <button
              className="icon-button"
              aria-label="发送问题"
              disabled={!node.draft.trim() || !!activeRun}
              onClick={props.onSend}
            >
              <ArrowUp size={18} />
            </button>
          </div>
          <button
            className="outline return-button"
            disabled={
              !!activeRun ||
              !messages.some(
                (m) => m.role === "assistant" && m.status === "complete",
              )
            }
            onClick={props.onSummary}
          >
            {node.parentId ? "整理并返回" : "整理这段"}
          </button>
        </div>
        <div className="composer-meta">
          <span>
            {props.saveStatus === "saved"
              ? "已保存"
              : props.saveStatus === "error"
                ? "保存失败"
                : "保存中…"}
          </span>
          {props.saveStatus === "error" ? (
            <button onClick={props.onRetrySave}>重试保存</button>
          ) : (
            <button onClick={props.onConcepts}>本书概念档案</button>
          )}
        </div>
      </div>
    </section>
  );
}
function ArrowRightSmall() {
  return <CaretRight size={14} />;
}
