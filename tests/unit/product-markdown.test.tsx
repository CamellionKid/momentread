// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, safeMarkdownHref } from "../../src/product/Markdown";
import { selectedMessageOrigin } from "../../src/product/model";
import { readableConceptContext } from "../../src/product/ConceptContext";
import type { Message } from "../../shared/contracts";
const message = (text: string): Message => ({
  id: "message",
  bookId: "book",
  discussionId: "discussion",
  role: "assistant",
  text,
  status: "complete",
  runId: "run",
  createdAt: "2026-09-10T00:00:00Z",
});
function render(text: string) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Markdown text={text} />);
  document.body.append(host);
  return host;
}
function select(host: HTMLElement, needle: string, occurrence = 0) {
  const full = host.textContent ?? "";
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = full.indexOf(needle, start + 1);
  if (start < 0) throw new Error(`Missing visible text ${needle}: ${full}`);
  const end = start + needle.length;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0,
    started = false,
    finished = false;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const next = offset + node.data.length;
    if (!started && start >= offset && start < next) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end > offset && end <= next) {
      range.setEnd(node, end - offset);
      finished = true;
      break;
    }
    offset = next;
  }
  if (!finished) throw new Error("Could not set end");
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
describe("Markdown rendering with exact source selection", () => {
  it("renders headings, emphasis, lists, quotes, GFM tables and code as semantic elements", () => {
    const host = render(
      "## 概念\n\n**理性**与*判断*。\n\n- 甲\n- 乙\n\n> 这是引用\n\n| 概念 | 语境 |\n| --- | --- |\n| 判断 | 此处 |\n\n`inline`\n\n```js\nconst x = 1\n```",
    );
    expect(host.querySelector("h2")?.textContent).toBe("概念");
    expect(host.querySelector("strong")?.textContent).toBe("理性");
    expect(host.querySelector("em")?.textContent).toBe("判断");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("blockquote")?.textContent).toContain("引用");
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("pre code")?.textContent).toContain("const x");
    expect(host.textContent).not.toContain("##");
  });
  it("locates the second identical Chinese word with emoji before it", () => {
    const source = "## 🧭 导言\n\n理性。**理性**。";
    const host = render(source);
    const origin = selectedMessageOrigin(
      host,
      message(source),
      select(host, "理性", 1),
    );
    const start = source.indexOf("理性", source.indexOf("理性") + 2);
    expect(origin).toEqual({
      messageId: "message",
      start,
      end: start + 2,
      exact: "理性",
    });
  });
  it("maps a selection across strong, emphasis, links and inline code to one original slice", () => {
    const source =
      "这是**理性**与*判断*和[经验](https://example.com)及`范畴`。";
    const host = render(source);
    const origin = selectedMessageOrigin(
      host,
      message(source),
      select(host, "理性与判断和经验及范畴"),
    );
    expect(origin?.exact).toBe(
      "理性**与*判断*和[经验](https://example.com)及`范畴",
    );
    expect(origin?.start).toBe(source.indexOf("理性"));
    expect(source.slice(origin!.start, origin!.end)).toBe(origin?.exact);
  });
  it("decodes entity and escaped punctuation while preserving raw source offsets", () => {
    const source = "这是 &amp;、&#x1F9ED;、\\*星号\\* 和 &copy;。";
    const host = render(source);
    expect(host.textContent).toBe("这是 &、🧭、*星号* 和 ©。");
    for (const [visible, raw] of [
      ["&", "&amp;"],
      ["🧭", "&#x1F9ED;"],
      ["*星号*", "\\*星号\\*"],
      ["©", "&copy;"],
    ]) {
      const origin = selectedMessageOrigin(
        host,
        message(source),
        select(host, visible),
      );
      expect(origin?.exact).toBe(raw);
      expect(origin?.start).toBe(source.indexOf(raw));
    }
  });
  it("maps inline code newline normalization and fenced code without the fences", () => {
    const source = "`甲\n乙`\n\n```text\n中文🧭代码\nnext line\n```";
    const host = render(source);
    expect(
      selectedMessageOrigin(host, message(source), select(host, "甲 乙"))
        ?.exact,
    ).toBe("甲\n乙");
    expect(
      selectedMessageOrigin(host, message(source), select(host, "中文🧭代码"))
        ?.exact,
    ).toBe("中文🧭代码");
    expect(
      selectedMessageOrigin(host, message(source), select(host, "代码\nnext"))
        ?.exact,
    ).toBe("代码\nnext");
  });
  it("maps table cell text to its own source position", () => {
    const source = "| 术语 | 说明 |\n| --- | --- |\n| 理性 | 判断 |";
    const host = render(source);
    expect(
      selectedMessageOrigin(host, message(source), select(host, "判断"))?.start,
    ).toBe(source.indexOf("判断"));
  });
  it("rejects a selection splitting an entity expansion or an emoji surrogate pair", () => {
    const source = "&#x1F9ED; 与 🧭";
    const host = render(source);
    expect(() =>
      selectedMessageOrigin(host, message(source), select(host, "\ud83e")),
    ).toThrow("无法准确定位");
  });
  it("rejects generated image captions, unmapped content and altered text nodes", () => {
    const source = "![外部图](https://tracker.example/image.png)\n\n正常文字";
    const host = render(source);
    expect(() =>
      selectedMessageOrigin(host, message(source), select(host, "外部图")),
    ).toThrow("无法准确定位");
    const span = [...host.querySelectorAll<HTMLElement>("[data-mr-map]")].find(
      (s) => s.textContent === "正常文字",
    )!;
    span.textContent = "篡改文字";
    expect(() =>
      selectedMessageOrigin(host, message(source), select(host, "篡改文字")),
    ).toThrow("无法准确定位");
  });
  it("never enables raw HTML, script, remote images or javascript links", () => {
    const source =
      '<script>alert(1)</script>\n\n<img src="https://tracker.example/x">\n\n![图](https://tracker.example/x)\n\n[危险](javascript:alert%281%29) [来源](https://example.com/source)';
    const host = render(source);
    expect(host.querySelector("script,img,iframe")).toBeNull();
    expect(
      [...host.querySelectorAll("a")].some((a) =>
        a.href.startsWith("javascript:"),
      ),
    ).toBe(false);
    const link = host.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/source"]',
    );
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(safeMarkdownHref("data:text/html,unsafe")).toBeUndefined();
  });
  it("handles incomplete streaming Markdown with the same safe renderer", () => {
    const host = render("## 正在解释\n\n**未结束的概念");
    expect(host.querySelector("h2")?.textContent).toBe("正在解释");
    expect(host.textContent).toContain("未结束的概念");
    expect(host.querySelector("script,img")).toBeNull();
  });
  it("extracts readable concept provenance without exposing IDs or CFI", () => {
    const context = JSON.stringify({
      origin: { messageId: "private-id", start: 3, end: 5, exact: "理性" },
      source: {
        bookId: "book-id",
        segments: [
          { chapter: "第一章", exact: "真实选段", cfi: "epubcfi(secret)" },
        ],
      },
    });
    expect(readableConceptContext(context)).toEqual({
      kind: "structured",
      origin: "理性",
      segments: [{ chapter: "第一章", exact: "真实选段" }],
    });
    expect(readableConceptContext("普通语境说明")).toEqual({
      kind: "text",
      text: "普通语境说明",
    });
  });
});
