import { useEffect, useState } from "react";
import {
  ArrowRight,
  DownloadSimple,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../api";
import type {
  BookState,
  DailyReport,
  Discussion,
  SourceCandidate,
  SummaryVersion,
} from "../../shared/contracts";
import type { RuntimeProbe } from "../../shared/contracts/ports";
import { Dialog } from "./Dialog";
import { isActiveRun, localDate } from "./model";
import { Markdown } from "./Markdown";
import { ConceptContext } from "./ConceptContext";
export function ImportPanel({
  kind,
  onClose,
  onDone,
  bookId,
}: {
  kind: "book" | "original" | "restore";
  onClose: () => void;
  onDone: (bookId?: string) => void;
  bookId?: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title =
    kind === "restore"
      ? "从备份恢复"
      : kind === "original"
        ? "补充原著文件"
        : "导入 EPUB";
  async function submit() {
    if (!file) {
      setError("请先选择文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (kind === "book") {
        const book = await api.importBook(file);
        onDone(book.id);
      } else if (kind === "original") {
        await api.importOriginal(bookId!, file);
        onDone();
      } else {
        await api.restore(file);
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        {kind === "book"
          ? "选择可复制文字的 EPUB，文件会复制到本地书库。"
          : kind === "original"
            ? "原著只关联当前书籍。补充后可重新匹配，旧来源和已确认小结会保留。"
            : "选择 MomentRead 导出的 ZIP 备份；仅能恢复到空书库。"}
      </p>
      <label className="import-zone">
        <UploadSimple size={30} weight="light" />
        <strong>{file?.name || "点击选择文件"}</strong>
        <span>
          {kind === "restore"
            ? "MomentRead ZIP"
            : kind === "book"
              ? "EPUB 格式"
              : "EPUB 或 TXT 格式"}
        </span>
        <input
          aria-label="选择文件"
          type="file"
          accept={
            kind === "restore"
              ? ".zip"
              : kind === "book"
                ? ".epub"
                : ".epub,.txt"
          }
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError("");
          }}
          disabled={busy}
        />
      </label>
      {error && (
        <p className="product-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="outline" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy
            ? "正在处理…"
            : kind === "restore"
              ? "恢复书库"
              : kind === "original"
                ? "保存原著"
                : "导入并打开"}
        </button>
      </div>
    </Dialog>
  );
}
export function SourcePanel({
  state,
  node,
  onClose,
  onRefresh,
  onImport,
  onRematch,
}: {
  state: BookState;
  node: Discussion;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onImport: () => void;
  onRematch: () => void;
}) {
  const sources = state.sources
    .filter((s) => s.discussionId === node.rootId || s.discussionId === node.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const root = state.discussions.find((d) => d.id === node.rootId);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function update(
    source: SourceCandidate,
    patch: {
      selected?: boolean;
      verification?: "unverified" | "confirmed" | "conflict";
    },
  ) {
    setBusy(source.id);
    setError("");
    try {
      await api.source(source.id, patch);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Dialog title="原著依据与核对" wide onClose={onClose}>
      <p className="muted">
        候选被选中后仍是待核对状态。只有实际取回的文本可以确认作为依据。
      </p>
      <div className="source-detail">
        <small>中文选段</small>
        <p>
          {root?.source?.segments.map((s) => s.exact).join("\n\n") ||
            "这场讨论没有正文引用。"}
        </p>
      </div>
      <div className="product-inline-actions">
        <button
          className="outline small"
          onClick={onRematch}
          disabled={state.runs.some(
            (r) => r.discussionId === node.id && isActiveRun(r),
          )}
        >
          重新寻找原著
        </button>
        <button className="outline small" onClick={onImport}>
          补充原著文件
        </button>
      </div>
      {error && (
        <p role="alert" className="product-error">
          {error}
        </p>
      )}
      {sources.length ? (
        <div className="product-source-list">
          {sources.map((source) => (
            <article key={source.id} className="product-source-card">
              <div className="product-source-heading">
                <strong>{source.title || "来源候选"}</strong>
                <span>
                  {source.retrieval === "retrieved"
                    ? source.verification === "confirmed"
                      ? "已核对"
                      : source.verification === "conflict"
                        ? "存在冲突"
                        : "待核对"
                    : source.retrieval === "fetch_failed"
                      ? "取回失败"
                      : "未取回"}
                </span>
              </div>
              <p className="quiet-note">
                {source.language} · {source.version || "版本未标明"} ·{" "}
                {source.locator || "位置未标明"}
              </p>
              {source.retrieval === "retrieved" && source.quote ? (
                <blockquote className="product-source-quote">
                  {source.quote}
                </blockquote>
              ) : (
                <p className="muted">没有可引用的原著文本。</p>
              )}
              <p className="quiet-note">{source.reason}</p>
              {/^https?:\/\//.test(source.url) && (
                <a
                  className="product-source-url"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看来源页面 ↗
                </a>
              )}
              <small className="product-source-date">
                {new Date(source.createdAt).toLocaleString()} · 此来源版本已保留
              </small>
              <div className="product-inline-actions">
                <button
                  className="outline small"
                  disabled={!!busy || source.retrieval !== "retrieved"}
                  onClick={() =>
                    void update(source, { selected: !source.selected })
                  }
                >
                  {source.selected ? "取消选中" : "选作候选"}
                </button>
                <button
                  className="outline small"
                  disabled={
                    !!busy || source.retrieval !== "retrieved" || !source.quote
                  }
                  onClick={() =>
                    void update(
                      source,
                      source.verification === "confirmed"
                        ? { verification: "unverified" }
                        : { verification: "confirmed", selected: true },
                    )
                  }
                >
                  {source.verification === "confirmed"
                    ? "退回待核对"
                    : "我已对照确认"}
                </button>
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() =>
                    void update(source, { verification: "conflict" })
                  }
                >
                  标记冲突
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-source">
          <WarningCircle size={24} />
          <h3>还没有原著依据</h3>
          <p>可以继续做中文解析。原著尚未取回时，不会把回译当作原句。</p>
        </div>
      )}
    </Dialog>
  );
}
export function HistoryPanel({
  node,
  onClose,
}: {
  node: Discussion;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<SummaryVersion[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void api
      .history(node.id)
      .then((value) => {
        if (!disposed) setHistory(value);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [node.id]);
  return (
    <Dialog title={`「${node.title}」的小结历史`} wide onClose={onClose}>
      {error ? (
        <p className="product-error" role="alert">
          {error}
        </p>
      ) : history === null ? (
        <p role="status">正在读取历史…</p>
      ) : history.length ? (
        history.map((s) => (
          <article key={s.id} className="product-source-card">
            <h3>
              {s.confirmed ? `版本 ${s.version}` : "待确认草稿"}{" "}
              <small>
                {new Date(s.confirmedAt ?? s.createdAt).toLocaleString()}
              </small>
            </h3>
            <Markdown text={s.content} />
            <small>
              {s.dependencies.length} 条子小结依据 · {s.sourceIds.length}{" "}
              条原著来源
            </small>
          </article>
        ))
      ) : (
        <p className="muted">这场讨论还没有小结。</p>
      )}
    </Dialog>
  );
}
export function ConceptsPanel({
  state,
  onClose,
  onSelect,
}: {
  state: BookState;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Dialog title="本书概念档案" wide onClose={onClose}>
      <p className="muted">
        义项按照具体讨论与语境保留。同名词不会自动合并，确认小结后才写入档案。
      </p>
      {state.concepts.length ? (
        state.concepts.map((concept) => (
          <article className="product-source-card" key={concept.id}>
            <div className="product-source-heading">
              <h3>{concept.title}</h3>
              <span>{concept.originalTerm}</span>
            </div>
            <Markdown text={concept.definition} />
            <details>
              <summary>适用语境与依据</summary>
              <ConceptContext context={concept.context} />
              <small>{concept.sourceIds.length} 条来源</small>
            </details>
            <button
              className="text-button"
              onClick={() => onSelect(concept.discussionId)}
            >
              回到相关讨论 <ArrowRight size={17} />
            </button>
          </article>
        ))
      ) : (
        <div className="empty-state">
          <h3>理解会在这里累积</h3>
          <p>先展开一个概念，再整理并确认小结。</p>
        </div>
      )}
    </Dialog>
  );
}
export function RuntimePanel({
  probe,
  onClose,
  onProbe,
  onBackup,
}: {
  probe: RuntimeProbe | null;
  onClose: () => void;
  onProbe: () => void;
  onBackup: () => void;
}) {
  return (
    <Dialog title="AI 连接与本地数据" onClose={onClose}>
      <div className="setting-row">
        <div>
          <strong>Claude Code CLI</strong>
          <p>{probe?.version || "尚未检测版本"}</p>
        </div>
        <span>{probe?.installed ? "已安装" : "未检测到"}</span>
      </div>
      <p className="muted">{probe?.message || "正在检测连接…"}</p>
      <p className="quiet-note">
        安装和登录状态不等于调用成功。真实解析完成后才表示这次调用可用。
      </p>
      <div className="product-inline-actions">
        <button className="outline" onClick={onProbe}>
          重新检测连接
        </button>
        <button className="outline" onClick={onBackup}>
          <DownloadSimple size={17} /> 备份书库
        </button>
      </div>
      <div className="aside-rule" />
      <p className="quiet-note">
        书籍与学习记录保存在本机。请等输入区显示「已保存」后关闭窗口；网络查询会单独展示权限请求。
      </p>
    </Dialog>
  );
}
export function ReportPage({
  state,
  onReturn,
  onError,
  onGenerate,
}: {
  state: BookState;
  onReturn: () => void;
  onError: (message: string) => void;
  onGenerate: (date: string, timezone: string) => Promise<void>;
}) {
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  );
  const [date, setDate] = useState(() => localDate(timezone));
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const active = state.runs.some(
    (run) => run.purpose === "daily" && isActiveRun(run),
  );
  const stamp = state.runs
    .filter((run) => run.purpose === "daily")
    .map((run) => `${run.id}:${run.status}`)
    .join();
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void api
      .report(state.book.id, date, timezone)
      .then((value) => {
        if (!disposed) setReport(value);
      })
      .catch((e) => {
        if (!disposed) onError(e.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [state.book.id, date, timezone, stamp]);
  return (
    <main className="summary-page">
      <div className="summary-heading">
        <p className="eyebrow">A DAY OF READING</p>
        <h1>今天，向理解靠近了一点。</h1>
        <p>记录读到哪里，也留下还想继续的问题。</p>
      </div>
      <div className="product-report-controls">
        <label>
          阅读日期
          <input
            aria-label="阅读日期"
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
          />
        </label>
        <label>
          时区
          <select
            aria-label="报告时区"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {[
              ...new Set([
                Intl.DateTimeFormat().resolvedOptions().timeZone,
                "Asia/Shanghai",
                "UTC",
                "Europe/Berlin",
                "America/New_York",
              ]),
            ]
              .filter(Boolean)
              .map((zone) => (
                <option key={zone}>{zone}</option>
              ))}
          </select>
        </label>
      </div>
      <section className="summary-book">
        <div>
          <span className="author">{state.book.author}</span>
          <h2>{state.book.title}</h2>
          <p>{report?.activities.at(-1)?.chapter || "本日尚未记录阅读位置"}</p>
        </div>
        <button className="outline" onClick={onReturn}>
          回到阅读 <ArrowRight size={17} />
        </button>
      </section>
      {loading && (
        <p role="status" className="quiet-note">
          正在读取当天记录…
        </p>
      )}
      {report && (
        <>
          <div className="reading-facts">
            <div>
              <strong>
                {report.discussions.filter((d) => !d.parentId).length}
              </strong>
              <span>选段解析</span>
            </div>
            <div>
              <strong>
                {report.discussions.filter((d) => d.parentId).length}
              </strong>
              <span>概念讨论</span>
            </div>
            <div>
              <strong>{report.summaries.length}</strong>
              <span>已确认小结</span>
            </div>
          </div>
          <section className="summary-section">
            <div className="section-label">
              01 <span>留下的理解</span>
            </div>
            <div>
              {report.summaries.length ? (
                report.summaries.map((s) => (
                  <article className="product-summary-entry" key={s.id}>
                    <h3>
                      {state.discussions.find((d) => d.id === s.discussionId)
                        ?.title || "讨论小结"}
                    </h3>
                    <Markdown text={s.content} />
                  </article>
                ))
              ) : (
                <p className="muted">
                  这一天还没有确认的小结。完成一次讨论后，可以整理留下理解。
                </p>
              )}
            </div>
          </section>
          <section className="summary-section">
            <div className="section-label">
              02 <span>原著依据</span>
            </div>
            <div>
              <p>
                {
                  report.sources.filter((s) => s.verification === "confirmed")
                    .length
                }{" "}
                条已核对，
                {
                  report.sources.filter((s) => s.verification !== "confirmed")
                    .length
                }{" "}
                条待核对或有冲突。
              </p>
              <p className="quiet-note">
                待核对的来源保留其状态，不代表已经确定对应原文。
              </p>
            </div>
          </section>
          <section className="summary-section">
            <div className="section-label">
              03 <span>总结与下一步</span>
            </div>
            <div>
              <Markdown
                text={
                  report.advice ||
                  "根据当天的阅读和已确认小结，生成回顾与建议。"
                }
              />
              <button
                className="outline small"
                disabled={
                  active ||
                  (!report.activities.length && !report.summaries.length)
                }
                onClick={() => void onGenerate(date, timezone)}
              >
                {active ? "正在生成总结…" : "生成总结与建议"}
              </button>
            </div>
          </section>
          <div className="product-report-footer">
            <p className="quiet-note">
              导出内容来自已保存记录，HTML 可以离线打开。
            </p>
            <a
              className="primary product-download"
              href={`/api/books/${state.book.id}/report.html?date=${date}&timezone=${encodeURIComponent(timezone)}`}
              download
            >
              <DownloadSimple size={18} /> 导出 HTML 小结
            </a>
          </div>
        </>
      )}
    </main>
  );
}
