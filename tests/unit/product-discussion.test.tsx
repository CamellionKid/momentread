// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BookState, RunEvent } from "../../shared/contracts";
import {
  DiscussionPane,
  type BranchSelection,
} from "../../src/product/DiscussionPane";
import { readRunRetry, RunRetryNotice } from "../../src/product/RunRetryNotice";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const time = "2026-09-10T00:00:00.000Z";
const state = (): BookState => ({
  book: {
    id: "book-a",
    title: "测试书",
    author: "Author",
    language: "zh",
    fileVersionId: "file-a",
    createdAt: time,
  },
  workspace: {
    id: "book-a",
    bookId: "book-a",
    activeDiscussionId: "root-a",
    position: null,
    collapsed: [],
    fontSize: 24,
    flow: "scrolled" as const,
    updatedAt: time,
  },
  discussions: [
    {
      id: "root-a",
      bookId: "book-a",
      parentId: null,
      rootId: "root-a",
      title: "选段解析",
      source: null,
      origin: null,
      draft: "",
      scrollTop: 0,
      revision: 0,
      needsMerge: false,
      createdAt: time,
    },
  ],
  messages: [],
  summaries: [],
  receipts: [],
  sources: [],
  concepts: [],
  activities: [],
  runs: [
    {
      id: "run-a",
      bookId: "book-a",
      discussionId: "root-a",
      purpose: "discussion",
      status: "failed",
      contextSnapshotId: "context-a",
      sessionId: null,
      sessionReusable: false,
      partialText: "",
      result: null,
      error: "额度尚未恢复，请稍后重试。",
      createdAt: time,
      updatedAt: time,
    },
  ],
});
const noop = () => {};
function render(
  bookState: BookState,
  retries?: React.ComponentProps<typeof DiscussionPane>["retries"],
) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <DiscussionPane
      state={bookState}
      node={bookState.discussions[0]}
      retries={retries}
      saveStatus="saved"
      onDraft={noop}
      onScroll={noop}
      onSend={noop}
      onSummary={noop}
      onSelect={noop}
      onBranch={noop}
      onSources={noop}
      onHistory={noop}
      onConcepts={noop}
      onLocate={noop}
      onCancel={noop}
      onAncestors={noop}
      onCollapse={noop}
      onExpand={noop}
      onPreview={noop}
      onRetrySave={noop}
    />,
  );
  return host;
}
const event = (data: RunEvent["data"]): RunEvent => ({
  runId: "run-a",
  bookId: "book-a",
  discussionId: "root-a",
  seq: 1,
  type: "retrying",
  data,
  createdAt: time,
});

describe("discussion actionable failure and retry feedback", () => {
  it("does not suggest immediate summary when no complete assistant reply exists", () => {
    const bookState = state();
    bookState.messages = [
      {
        id: "partial-a",
        bookId: "book-a",
        discussionId: "root-a",
        role: "assistant",
        text: "未完成的解释",
        status: "interrupted",
        runId: "run-a",
        createdAt: time,
      },
    ];
    const host = render(bookState);
    expect(host.querySelector(".product-run-error")?.textContent).toContain(
      "获得完整回答后再整理",
    );
    expect(host.querySelector(".product-run-error")?.textContent).not.toContain(
      "或重新整理",
    );
    expect(
      host.querySelector<HTMLButtonElement>(".return-button")?.disabled,
    ).toBe(true);
  });
  it("offers summary only when the current discussion has a complete reply", () => {
    const bookState = state();
    const complete = {
      id: "answer-a",
      bookId: "book-a",
      discussionId: "root-a",
      role: "assistant" as const,
      text: "已完成的解释",
      status: "complete" as const,
      runId: "previous-run",
      createdAt: time,
    };
    bookState.messages = [{ ...complete, discussionId: "sibling" }];
    expect(
      render(bookState).querySelector<HTMLButtonElement>(".return-button")
        ?.disabled,
    ).toBe(true);
    bookState.messages.push(complete);
    const host = render(bookState);
    expect(host.querySelector(".product-run-error")?.textContent).toContain(
      "重新整理已有完整回答",
    );
    expect(
      host.querySelector<HTMLButtonElement>(".return-button")?.disabled,
    ).toBe(false);
  });
  it("shows retry number, safe error category and wait while keeping cancellation available", () => {
    const bookState = state();
    bookState.runs[0].status = "running";
    const retry = readRunRetry(
      event({
        attempt: 2,
        maxRetries: 10,
        delayMs: 4500,
        errorCategory: "rate_limit",
        status: 429,
      }),
    )!;
    const host = render(bookState, { "run-a": retry });
    expect(host.querySelector(".product-retry-notice")?.textContent).toContain(
      "第 2 / 10 次",
    );
    expect(host.querySelector(".product-retry-notice")?.textContent).toContain(
      "调用频率或额度受限（429）",
    );
    expect(host.querySelector(".product-retry-notice")?.textContent).toContain(
      "本轮等待约 5 秒",
    );
    expect(host.textContent).toContain("停止生成");
    expect(
      render(bookState, { "another-run": retry }).querySelector(
        ".product-retry-notice",
      ),
    ).toBeNull();
  });
  it("does not expose unknown provider categories or invalid retry metadata", () => {
    const retry = readRunRetry(
      event({
        attempt: -1,
        maxRetries: "10",
        delayMs: Infinity,
        errorCategory: "secret-provider-detail",
        status: "API KEY",
      }),
    )!;
    const html = renderToStaticMarkup(<RunRetryNotice retry={retry} />);
    expect(html).toContain("连接暂时未完成");
    expect(html).not.toContain("secret-provider-detail");
    expect(html).not.toContain("API KEY");
    expect(html).not.toContain("Infinity");
  });
});

describe("floating concept-branch bar", () => {
  it("floats the branch action after selecting answer text, without scrolling to the message footer", async () => {
    const bookState = state();
    bookState.runs = [];
    bookState.messages = [
      {
        id: "answer-a",
        bookId: "book-a",
        discussionId: "root-a",
        role: "assistant",
        text: "本原（arche）是万物由以产生又复归于它的东西。",
        status: "complete",
        runId: null,
        createdAt: time,
      },
    ];
    let captured: BranchSelection | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <DiscussionPane
          state={bookState}
          node={bookState.discussions[0]}
          saveStatus="saved"
          onDraft={noop}
          onScroll={noop}
          onSend={noop}
          onSummary={noop}
          onSelect={noop}
          onBranch={(value) => {
            captured = value;
          }}
          onSources={noop}
          onHistory={noop}
          onConcepts={noop}
          onLocate={noop}
          onCancel={noop}
          onAncestors={noop}
          onCollapse={noop}
          onExpand={noop}
          onPreview={noop}
          onRetrySave={noop}
        />,
      );
    });
    expect(host.querySelector(".discussion-selection-bar")).toBeNull();
    const textEl = host.querySelector<HTMLElement>(".product-message-text")!;
    const walker = document.createTreeWalker(textEl, 4);
    const textNode = walker.nextNode() as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      textEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const bar = host.querySelector(".discussion-selection-bar");
    expect(bar?.textContent).toContain("已选 4 字");
    expect(bar?.textContent).toContain("展开已选中的概念");
    expect(host.querySelector(".answer-actions button")).toBeNull();
    await act(async () => {
      bar!
        .querySelector("button.primary")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(captured).toMatchObject({
      parentId: "root-a",
      origin: { messageId: "answer-a", start: 0, end: 4 },
    });
    expect(host.querySelector(".discussion-selection-bar")).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });
});
