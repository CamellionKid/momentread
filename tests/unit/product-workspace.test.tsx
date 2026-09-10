// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookState, RunEvent } from "../../shared/contracts";
import { api } from "../../src/api";
import { useWorkspace } from "../../src/product/useWorkspace";
vi.mock("../../src/api", () => ({
  api: { state: vi.fn(), discussion: vi.fn(), workspace: vi.fn() },
}));
const date = "2026-09-10T00:00:00.000Z";
const state = (id = "book-a"): BookState => ({
  book: {
    id,
    title: id,
    author: "Author",
    language: "zh",
    fileVersionId: `${id}-file`,
    createdAt: date,
  },
  workspace: {
    id,
    bookId: id,
    position: null,
    activeDiscussionId: `${id}-root`,
    collapsed: [],
    fontSize: 24,
    updatedAt: date,
  },
  discussions: [
    {
      id: `${id}-root`,
      bookId: id,
      parentId: null,
      rootId: `${id}-root`,
      title: "根讨论",
      source: null,
      origin: null,
      draft: "server draft",
      scrollTop: 34,
      revision: 0,
      needsMerge: false,
      createdAt: date,
    },
    {
      id: `${id}-child`,
      bookId: id,
      parentId: `${id}-root`,
      rootId: `${id}-root`,
      title: "概念",
      source: null,
      origin: null,
      draft: "child draft",
      scrollTop: 72,
      revision: 0,
      needsMerge: false,
      createdAt: date,
    },
  ],
  messages: [],
  summaries: [],
  receipts: [],
  sources: [],
  concepts: [],
  runs: [],
  activities: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
let model: ReturnType<typeof useWorkspace>;
let root: Root;
let host: HTMLDivElement;
function Harness() {
  model = useWorkspace(() => {});
  return <div>{model.state?.book.title}</div>;
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(api.state).mockImplementation(async (id) => state(id));
  vi.mocked(api.discussion).mockImplementation(async (id, patch) => ({
    ...state().discussions[0],
    id,
    ...patch,
  }));
  vi.mocked(api.workspace).mockImplementation(async (id, patch) => ({
    ...state(id).workspace,
    ...patch,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("product workspace save and response ownership", () => {
  it("consumes retry SSE updates in sequence, ignores another book, and clears feedback when output resumes or the run finishes", async () => {
    class Stream {
      static instances: Stream[] = [];
      listeners = new Map<string, (event: Event) => void>();
      closed = false;
      constructor(public url: string) {
        Stream.instances.push(this);
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, listener);
      }
      close() {
        this.closed = true;
      }
      emit(event: RunEvent) {
        this.listeners.get("run")?.(
          new MessageEvent("run", { data: JSON.stringify(event) }),
        );
      }
    }
    vi.stubGlobal("EventSource", Stream);
    const active = state();
    active.runs = [
      {
        id: "run-a",
        bookId: "book-a",
        discussionId: "book-a-root",
        purpose: "discussion",
        status: "running",
        contextSnapshotId: "context-a",
        sessionId: null,
        sessionReusable: false,
        partialText: "",
        result: null,
        error: null,
        createdAt: date,
        updatedAt: date,
      },
    ];
    vi.mocked(api.state).mockResolvedValue(active);
    await act(async () => {
      await model.open("book-a");
    });
    const stream = Stream.instances.at(-1)!;
    const packet = (
      seq: number,
      type: RunEvent["type"] = "retrying",
    ): RunEvent => ({
      runId: "run-a",
      bookId: "book-a",
      discussionId: "book-a-root",
      seq,
      type,
      data: {
        attempt: seq,
        maxRetries: 10,
        delayMs: 3000,
        errorCategory: "rate_limit",
        status: 429,
      },
      createdAt: date,
    });
    await act(async () => {
      stream.emit(packet(1));
      stream.emit(packet(2));
    });
    expect(model.retries["run-a"]?.attempt).toBe(2);
    expect(model.retries["run-a"]?.errorCategory).toBe("rate_limit");
    await act(async () => {
      stream.emit({ ...packet(9), bookId: "book-b" });
    });
    expect(model.retries["run-a"]?.attempt).toBe(2);
    await act(async () => {
      stream.emit(packet(3, "text_delta"));
      stream.emit(packet(2));
    });
    expect(model.retries["run-a"]).toBeUndefined();
    await act(async () => {
      stream.emit(packet(4));
    });
    expect(model.retries["run-a"]?.attempt).toBe(4);
    vi.mocked(api.state).mockResolvedValue({
      ...active,
      runs: [{ ...active.runs[0], status: "failed", error: "稍后重试" }],
    });
    await act(async () => {
      stream.emit(packet(5, "failed"));
    });
    expect(model.retries["run-a"]).toBeUndefined();
    expect(stream.closed).toBe(true);
  });
  it("flushes a sibling draft before activating another discussion", async () => {
    await act(async () => {
      await model.open("book-a");
    });
    await act(async () => model.edit("book-a-root", { draft: "独立草稿" }));
    await act(async () => {
      await model.activate("book-a-child");
    });
    expect(api.discussion).toHaveBeenCalledWith("book-a-root", {
      draft: "独立草稿",
    });
    expect(model.state?.workspace.activeDiscussionId).toBe("book-a-child");
    expect(model.state?.discussions[0].draft).toBe("独立草稿");
    expect(model.state?.discussions[1].draft).toBe("child draft");
    expect(model.saveStatus).toBe("saved");
  });
  it("does not let a server refresh overwrite an unsaved local draft", async () => {
    await act(async () => {
      await model.open("book-a");
      model.edit("book-a-root", { draft: "尚未发送的新内容" });
      await model.refresh();
    });
    expect(model.state?.discussions[0].draft).toBe("尚未发送的新内容");
  });
  it("retains a draft on save failure and submits the same content on retry", async () => {
    await act(async () => {
      await model.open("book-a");
      model.edit("book-a-root", { draft: "网络失败也保留" });
    });
    vi.mocked(api.discussion).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(model.flush()).rejects.toThrow("offline");
    });
    expect(model.saveStatus).toBe("error");
    expect(model.state?.discussions[0].draft).toBe("网络失败也保留");
    await act(async () => {
      await model.flush();
    });
    expect(api.discussion).toHaveBeenLastCalledWith("book-a-root", {
      draft: "网络失败也保留",
    });
    expect(model.saveStatus).toBe("saved");
  });
  it("drains edits made while a previous save is in flight before reporting saved", async () => {
    await act(async () => {
      await model.open("book-a");
      model.edit("book-a-root", { draft: "第一版" });
    });
    const pending = deferred<ReturnType<typeof state>["discussions"][number]>();
    vi.mocked(api.discussion).mockReturnValueOnce(pending.promise);
    let save!: Promise<void>;
    await act(async () => {
      save = model.flush();
      await Promise.resolve();
    });
    await act(async () => model.edit("book-a-root", { draft: "第二版" }));
    await act(async () => {
      pending.resolve({ ...state().discussions[0], draft: "第一版" });
      await save;
    });
    expect(api.discussion).toHaveBeenLastCalledWith("book-a-root", {
      draft: "第二版",
    });
    expect(model.saveStatus).toBe("saved");
  });
  it("ignores a delayed response belonging to the book that was left", async () => {
    await act(async () => {
      await model.open("book-a");
    });
    const old = deferred<BookState>();
    vi.mocked(api.state).mockReturnValueOnce(old.promise);
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = model.refresh();
      await Promise.resolve();
    });
    await act(async () => {
      await model.open("book-b");
    });
    await act(async () => {
      old.resolve(state("book-a"));
      await refresh;
    });
    expect(model.state?.book.id).toBe("book-b");
    expect(host.textContent).toBe("book-b");
  });
  it("saves position and font changes to the current book without discarding per-discussion scroll", async () => {
    await act(async () => {
      await model.open("book-a");
      model.edit("book-a-child", { scrollTop: 820 });
      model.workspace({ fontSize: 28 });
      await model.flush();
    });
    expect(api.discussion).toHaveBeenCalledWith("book-a-child", {
      scrollTop: 820,
    });
    expect(api.workspace).toHaveBeenCalledWith("book-a", { fontSize: 28 });
    expect(model.state?.discussions[1].scrollTop).toBe(820);
  });
});
