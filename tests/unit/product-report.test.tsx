// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookState, DailyReport, Run } from "../../shared/contracts";
import { api } from "../../src/api";
import { ReportPage } from "../../src/product/Panels";
import { latestDailyRun } from "../../src/product/daily-run";
import { localDate } from "../../src/product/model";
import type { RunRetry } from "../../src/product/RunRetryNotice";

const timezone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const date = localDate(timezone);
const savedAt = "2026-09-10T00:00:00.000Z";
const initialState = (): BookState => ({
  book: {
    id: "book-a",
    title: "真实阅读记录",
    author: "Author",
    language: "zh",
    fileVersionId: "file-a",
    createdAt: savedAt,
  },
  workspace: {
    id: "book-a",
    bookId: "book-a",
    position: null,
    activeDiscussionId: null,
    collapsed: [],
    fontSize: 24,
    updatedAt: savedAt,
  },
  discussions: [],
  messages: [],
  summaries: [],
  receipts: [],
  sources: [],
  concepts: [],
  runs: [],
  activities: [
    {
      id: "activity-a",
      bookId: "book-a",
      fileVersionId: "file-a",
      cfi: "epubcfi(/6/2!/4/2:0)",
      progress: 0.1,
      chapter: "第一章",
      createdAt: savedAt,
    },
  ],
});
const dailyRun = (patch: Partial<Run> = {}): Run => ({
  id: "run-a",
  bookId: "book-a",
  discussionId: "root-a",
  purpose: "daily",
  reportTarget: { date, timezone },
  status: "queued",
  contextSnapshotId: "context-a",
  sessionId: null,
  sessionReusable: false,
  partialText: "",
  result: null,
  error: null,
  createdAt: savedAt,
  updatedAt: savedAt,
  ...patch,
});

let root: Root;
let host: HTMLDivElement;
let updateState: React.Dispatch<React.SetStateAction<BookState>>;
let advice: string;
let postCount: number;
let postError: string | undefined;
let observeAcceptedRun: boolean;
const onError = vi.fn();

function Harness({ initial }: { initial: BookState }) {
  const [state, setState] = useState(initial);
  updateState = setState;
  return (
    <ReportPage
      state={state}
      onReturn={() => {}}
      onError={onError}
      onGenerate={async (targetDate, targetTimezone) => {
        // Exercise the real client with HTTP 202 before delivering a later run update.
        const accepted = await api.generateReport(
          state.book.id,
          targetDate,
          targetTimezone,
        );
        if (observeAcceptedRun) {
          setState((previous) => ({
            ...previous,
            runs: [
              ...previous.runs,
              dailyRun({
                id: accepted.runId,
                bookId: previous.book.id,
                reportTarget: { date: targetDate, timezone: targetTimezone },
                createdAt: `2026-09-10T00:00:0${postCount}.000Z`,
              }),
            ],
          }));
        }
        return accepted;
      }}
    />
  );
}
async function mount(initial = initialState(), key = "first") {
  await act(async () => {
    root.render(<Harness key={key} initial={initial} />);
  });
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(found, `Expected button: ${label}`).toBeTruthy();
  return found!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function finish(
  status: Run["status"],
  error: string | null,
  result: Run["result"] = null,
) {
  await act(async () => {
    updateState((previous) => ({
      ...previous,
      runs: previous.runs.map((run, index) =>
        index === previous.runs.length - 1
          ? { ...run, status, error, result }
          : run,
      ),
    }));
  });
}
async function changeDate(value: string) {
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="阅读日期"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  advice = "";
  postCount = 0;
  postError = undefined;
  observeAcceptedRun = true;
  onError.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (options?.method === "POST") {
        postCount += 1;
        return postError
          ? new Response(
              JSON.stringify({
                error: {
                  code: "AI_UNAVAILABLE",
                  message: postError,
                  retryable: true,
                },
              }),
              { status: 503 },
            )
          : new Response(JSON.stringify({ runId: `accepted-${postCount}` }), {
              status: 202,
            });
      }
      const state = initialState();
      const bookId = url.pathname.split("/")[3];
      const report: DailyReport = {
        book: { ...state.book, id: bookId },
        date: url.searchParams.get("date")!,
        timezone: url.searchParams.get("timezone")!,
        activities: state.activities,
        discussions: [],
        summaries: [],
        sources: [],
        concepts: [],
        advice,
      };
      return new Response(JSON.stringify(report), { status: 200 });
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe("daily report asynchronous failure and recovery", () => {
  it("keeps an accepted run disabled until refreshed state observes it", async () => {
    observeAcceptedRun = false;
    await mount();
    await click("生成总结与建议");
    expect(postCount).toBe(1);
    expect(button("正在生成总结…").disabled).toBe(true);
    await click("正在生成总结…");
    expect(postCount).toBe(1);

    await act(async () => {
      updateState((previous) => ({
        ...previous,
        runs: [
          dailyRun({
            id: "accepted-1",
            status: "completed",
            result: { advice: "完成", date, timezone, summaryIds: [] },
          }),
        ],
      }));
    });
    expect(button("生成总结与建议").disabled).toBe(false);
  });
  it("shows live retry feedback only for the displayed daily run", async () => {
    const active = {
      ...initialState(),
      runs: [dailyRun({ status: "running" })],
    };
    const retry: RunRetry = {
      runId: "run-a",
      discussionId: "root-a",
      attempt: 3,
      maxRetries: 10,
      delayMs: 8000,
      errorCategory: "server_error",
      status: 500,
    };
    await act(async () => {
      root.render(
        <ReportPage
          state={active}
          retries={{ "run-a": retry }}
          onReturn={() => {}}
          onError={onError}
          onGenerate={async () => ({ runId: "unused" })}
        />,
      );
    });
    expect(host.querySelector(".product-retry-notice")?.textContent).toContain(
      "第 3 / 10 次",
    );
    expect(host.querySelector(".product-retry-notice")?.textContent).toContain(
      "服务暂时异常（500）",
    );
    expect(button("正在生成总结…").disabled).toBe(true);
    await changeDate("2000-01-01");
    expect(host.querySelector(".product-retry-notice")).toBeNull();
  });
  it("shows the reason after HTTP 202 then failed, retains earlier advice, and allows a successful retry", async () => {
    advice = "上次成功留下的理解。";
    await mount();
    await click("生成总结与建议");
    expect(postCount).toBe(1);
    expect(button("正在生成总结…").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await finish("failed", "当前额度已用完，请在 18:00 恢复后重试。");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "本次总结生成失败",
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "18:00",
    );
    expect(host.textContent).toContain("上次成功生成的总结仍保留在下方。");
    expect(host.textContent).toContain(advice);
    expect(button("重试生成总结").disabled).toBe(false);

    await click("重试生成总结");
    expect(postCount).toBe(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button("正在生成总结…").disabled).toBe(true);
    advice = "重试成功后的新总结。";
    await finish("completed", null, { advice, date, timezone, summaryIds: [] });
    expect(host.textContent).toContain(advice);
    expect(host.textContent).not.toContain("上次成功留下的理解。");
    expect(button("生成总结与建议").disabled).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores a failed dated run on a fresh mount with no captured request id", async () => {
    const persisted = initialState();
    persisted.runs = [
      dailyRun({ status: "failed", error: "暂时无法连接，请重试。" }),
    ];
    await mount(persisted);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "暂时无法连接",
    );
    await mount(persisted, "after-browser-refresh");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "暂时无法连接",
    );
    expect(button("重试生成总结").disabled).toBe(false);
    expect(postCount).toBe(0);
  });

  it("does not show a failure under another reading date, timezone, or book", async () => {
    const persisted = initialState();
    persisted.runs = [
      dailyRun({ status: "failed", error: "只属于原日期的失败" }),
    ];
    await mount(persisted);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await changeDate("2000-01-01");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button("生成总结与建议").disabled).toBe(false);
    await changeDate(date);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "只属于原日期的失败",
    );
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="报告时区"]',
    )!;
    await act(async () => {
      select.value = timezone === "UTC" ? "Europe/Berlin" : "UTC";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await mount(
      { ...persisted, book: { ...persisted.book, id: "book-b" } },
      "other-book",
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["interrupted", "本次总结生成已中断"],
    ["cancelled", "本次总结生成已停止"],
  ] as const)(
    "shows a retryable %s run without inventing a successful summary",
    async (status, title) => {
      await mount({ ...initialState(), runs: [dailyRun({ status })] });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        title,
      );
      expect(host.textContent).toContain("尚未生成新的 AI 总结");
      expect(button("重试生成总结").disabled).toBe(false);
    },
  );

  it("also displays a rejected request near the report and clears it when retry is accepted", async () => {
    postError = "AI 尚未就绪，请检查连接。";
    await mount();
    await click("生成总结与建议");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      postError,
    );
    postError = undefined;
    await click("重试生成总结");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button("正在生成总结…").disabled).toBe(true);
  });
});

describe("daily run target ownership", () => {
  it("uses explicit target metadata, permits exact successful legacy results, and never infers a failed legacy date", () => {
    const legacyFailed = dailyRun({
      id: "legacy-failed",
      reportTarget: undefined,
      status: "failed",
    });
    const legacySuccess = dailyRun({
      id: "legacy-success",
      reportTarget: undefined,
      status: "completed",
      result: { date, timezone, advice: "saved" },
    });
    expect(latestDailyRun([legacyFailed], "book-a", date, timezone)).toBeNull();
    expect(
      latestDailyRun([legacyFailed], "book-a", date, timezone, legacyFailed.id),
    ).toBe(legacyFailed);
    expect(
      latestDailyRun([legacySuccess, legacyFailed], "book-a", date, timezone),
    ).toBe(legacySuccess);
    const otherDate = dailyRun({
      reportTarget: { date: "2000-01-01", timezone },
    });
    expect(
      latestDailyRun([otherDate], "book-a", date, timezone, otherDate.id),
    ).toBeNull();
    expect(
      latestDailyRun([legacySuccess], "book-a", date, "different-zone"),
    ).toBeNull();
  });
});
