import { mappedMarkdownSelection } from "./markdown-source";
import type {
  Discussion,
  Message,
  Run,
  BookState,
  SourceCandidate,
} from "../../shared/contracts";
export const isActiveRun = (run: Pick<Run, "status">) =>
  ["queued", "running", "permission"].includes(run.status);
export const ancestry = (nodes: Discussion[], id: string | null) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: Discussion[] = [];
  const seen = new Set<string>();
  let node = id ? byId.get(id) : undefined;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.unshift(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return path;
};
export function treeLayout(
  nodes: Discussion[],
  collapsed: string[],
  active: string | null,
) {
  const activePath = new Set(ancestry(nodes, active).map((n) => n.id));
  const children = new Map<string | null, Discussion[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const points: (Discussion & { x: number; y: number; folded: boolean })[] = [];
  const seen = new Set<string>();
  let cursor = 68;
  const walk = (node: Discussion, depth: number): number => {
    if (seen.has(node.id)) return cursor;
    seen.add(node.id);
    const kids = children.get(node.id) ?? [];
    const folded =
      kids.length > 0 &&
      collapsed.includes(node.id) &&
      !activePath.has(node.id);
    let y;
    if (kids.length && !folded) {
      const rows = kids.map((child) => walk(child, depth + 1));
      y = (rows[0] + rows[rows.length - 1]) / 2;
    } else {
      y = cursor;
      cursor += 106;
    }
    points.push({ ...node, x: 32 + depth * 63, y, folded });
    return y;
  };
  for (const root of children.get(null) ?? []) walk(root, 0);
  return {
    points,
    height: Math.max(500, cursor + 40),
    width: Math.max(170, ...points.map((p) => p.x + 46)),
  };
}
export function messageOrigin(
  message: Message,
  start: number,
  end: number,
  exact: string,
) {
  if (
    message.role !== "assistant" ||
    message.status !== "complete" ||
    start < 0 ||
    end <= start ||
    message.text.slice(start, end) !== exact
  )
    throw new Error("请在已完成的 AI 回答中重新选择概念。");
  return { messageId: message.id, start, end, exact };
}
export function selectedMessageOrigin(
  element: HTMLElement,
  message: Message,
  selection: Selection | null,
) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  if (
    !element.contains(range.startContainer) ||
    !element.contains(range.endContainer)
  )
    return null;
  if (
    element.matches("[data-mr-markdown]") ||
    element.querySelector("[data-mr-markdown]")
  ) {
    const mapped = mappedMarkdownSelection(element, message.text, selection);
    if (!mapped)
      throw new Error("这段排版文字无法准确定位，请缩小选区后重试。");
    return messageOrigin(message, mapped.start, mapped.end, mapped.exact);
  }
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const exact = range.toString();
  return messageOrigin(message, start, start + exact.length, exact);
}
export const summaryExcerpt = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !line.startsWith("#")) ?? text;
export const localDate = (timezone: string, date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export function rootSources(
  state: BookState,
  discussion: Discussion | null,
): SourceCandidate[] {
  if (!discussion) return [];
  return state.sources.filter(
    (source) =>
      source.discussionId === discussion.rootId ||
      source.discussionId === discussion.id,
  );
}
export const runLabel = (run: Pick<Run, "purpose" | "status">) =>
  run.status === "permission"
    ? "等待网络访问确认"
    : run.purpose === "matching"
      ? "正在寻找原著依据"
      : run.purpose === "summary"
        ? "正在整理讨论"
        : run.purpose === "daily"
          ? "正在整理今日阅读"
          : "正在解析";
