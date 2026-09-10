// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  ancestry,
  treeLayout,
  messageOrigin,
  selectedMessageOrigin,
  summaryExcerpt,
  localDate,
} from "../../src/product/model";
import type { Discussion, Message } from "../../shared/contracts";
const node = (id: string, parentId: string | null = null): Discussion => ({
  id,
  parentId,
  bookId: "book",
  rootId: "root",
  title: id,
  source: null,
  origin: null,
  draft: "",
  scrollTop: 0,
  revision: 0,
  needsMerge: false,
  createdAt: "2026-09-10T00:00:00.000Z",
});
const message = (text: string): Message => ({
  id: "m",
  bookId: "b",
  discussionId: "d",
  role: "assistant",
  text,
  status: "complete",
  runId: "r",
  createdAt: "2026-09-10T00:00:00.000Z",
});
describe("product graph and exact message origins", () => {
  it("keeps two siblings distinct and returns a deep immediate ancestry", () => {
    const nodes = [node("r"), node("a", "r"), node("b", "r"), node("c", "a")];
    expect(ancestry(nodes, "c").map((n) => n.id)).toEqual(["r", "a", "c"]);
    const graph = treeLayout(nodes, [], "c");
    expect(graph.points.find((n) => n.id === "a")!.x).toBe(
      graph.points.find((n) => n.id === "b")!.x,
    );
    expect(graph.points.find((n) => n.id === "a")!.y).not.toBe(
      graph.points.find((n) => n.id === "b")!.y,
    );
  });
  it("does not hide the active ancestor path and folds only other branches", () => {
    const nodes = [
      node("r"),
      node("a", "r"),
      node("b", "r"),
      node("c", "a"),
      node("d", "b"),
    ];
    const graph = treeLayout(nodes, ["a", "b"], "c");
    expect(graph.points.map((n) => n.id)).toContain("c");
    expect(graph.points.map((n) => n.id)).not.toContain("d");
    expect(graph.points.find((n) => n.id === "b")?.folded).toBe(true);
  });
  it("handles 500 nodes and a 20-level active path without dropping identities", () => {
    const nodes = [node("r")];
    for (let i = 1; i <= 20; i++)
      nodes.push(node(`deep${i}`, i === 1 ? "r" : `deep${i - 1}`));
    for (let i = 21; i < 500; i++) nodes.push(node(`sibling${i}`, "r"));
    const graph = treeLayout(nodes, [], "deep20");
    expect(graph.points).toHaveLength(500);
    expect(new Set(graph.points.map((n) => n.id)).size).toBe(500);
    expect(ancestry(nodes, "deep20")).toHaveLength(21);
    expect(graph.width).toBeGreaterThan(1200);
  });
  it("terminates ancestry traversal on malformed cycles", () => {
    expect(ancestry([node("a", "b"), node("b", "a")], "a")).toHaveLength(2);
  });
  it("validates exact UTF-16 offsets rather than searching repeated words", () => {
    const text = "理性。🧭理性。";
    const result = messageOrigin(message(text), 5, 7, "理性");
    expect(result.start).toBe(5);
    expect(() => messageOrigin(message(text), 0, 2, "感性")).toThrow();
    expect(() =>
      messageOrigin({ ...message(text), status: "streaming" }, 0, 2, "理性"),
    ).toThrow();
  });
  it("reads the selected second occurrence from real DOM ranges", () => {
    const el = document.createElement("div");
    el.textContent = "判断。判断。";
    document.body.append(el);
    const range = document.createRange();
    range.setStart(el.firstChild!, 3);
    range.setEnd(el.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(
      selectedMessageOrigin(el, message(el.textContent), selection),
    ).toEqual({ messageId: "m", start: 3, end: 5, exact: "判断" });
    el.remove();
  });
  it("rejects a selection crossing outside the message", () => {
    const outer = document.createElement("div");
    const el = document.createElement("div");
    el.textContent = "判断";
    outer.append(el, document.createTextNode("无关"));
    document.body.append(outer);
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(outer.lastChild!, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectedMessageOrigin(el, message("判断"), selection)).toBeNull();
    outer.remove();
  });
  it("keeps single-line manual summaries visible and computes the requested local date", () => {
    expect(summaryExcerpt("只有一段的编辑小结")).toBe("只有一段的编辑小结");
    expect(localDate("Asia/Shanghai", new Date("2026-09-09T20:00:00Z"))).toBe(
      "2026-09-10",
    );
    expect(localDate("UTC", new Date("2026-09-09T20:00:00Z"))).toBe(
      "2026-09-09",
    );
  });
});
