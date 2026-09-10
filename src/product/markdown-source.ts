/** UTF-16 boundary maps from rendered Markdown text back to the stored source. */
export type BoundaryMap = (number | null)[];
type Point = { offset?: number; column?: number };
export interface MarkdownNode {
  type: string;
  value?: string;
  tagName?: string;
  position?: { start: Point; end: Point };
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}
const punctuation = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
function entityValue(token: string): string | null {
  // The regex that calls this accepts only one complete character reference.
  // A detached textarea decodes browser entities; it never receives raw markup.
  if (typeof document === "undefined") return null;
  const decoder = document.createElement("textarea");
  decoder.innerHTML = token;
  return decoder.value === token ? null : decoder.value;
}
function append(map: BoundaryMap, text: string, start: number, end: number) {
  if (!map.length) map.push(start);
  else map[map.length - 1] = start;
  for (let index = 1; index < text.length; index++) map.push(null);
  map.push(end);
}
/** No guessing: if the decoded source differs, this leaf cannot start a branch. */
export function textBoundaryMap(
  raw: string,
  visible: string,
  start: number,
  markdown = true,
): BoundaryMap | null {
  const map: BoundaryMap = [];
  let decoded = "";
  for (let index = 0; index < raw.length; ) {
    const from = index;
    let token = String.fromCodePoint(raw.codePointAt(index)!);
    index += token.length;
    if (markdown && token === "\\" && punctuation.test(raw[index] ?? ""))
      token = raw[index++];
    else if (markdown && token === "&") {
      const entity = raw
        .slice(from)
        .match(
          /^&(?:#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/,
        );
      if (entity) {
        const value = entityValue(entity[0]);
        if (value !== null) {
          token = value;
          index = from + entity[0].length;
        }
      }
    } else if (token === "\r") {
      if (raw[index] === "\n") index++;
      token = "\n";
    }
    decoded += token;
    append(map, token, start + from, start + index);
  }
  if (!map.length) map.push(start);
  return decoded === visible ? map : null;
}
function codeSpanMap(
  raw: string,
  visible: string,
  start: number,
): BoundaryMap | null {
  const opening = raw.match(/^`+/)?.[0];
  if (!opening || !raw.endsWith(opening) || raw.length < opening.length * 2)
    return null;
  const body = raw.slice(opening.length, -opening.length);
  const decoded = body.replace(/\r\n?/g, "\n");
  let normalized = decoded.replace(/\n/g, " ");
  let map = textBoundaryMap(body, decoded, start + opening.length, false);
  if (!map) return null;
  if (
    normalized.startsWith(" ") &&
    normalized.endsWith(" ") &&
    /[^ ]/.test(normalized)
  ) {
    normalized = normalized.slice(1, -1);
    map = map.slice(1, -1);
  }
  return normalized === visible ? map : null;
}
function codeBlockMap(
  raw: string,
  visible: string,
  start: number,
): BoundaryMap | null {
  const lines: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const match of raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0] && offset === raw.length) continue;
    const text = match[0].replace(/[\r\n]+$/, "");
    lines.push({
      text,
      start: start + offset,
      end: start + offset + match[0].length,
    });
    offset += match[0].length;
  }
  const fence = lines[0]?.text.match(/^\s*(`{3,}|~{3,})/);
  if (fence) {
    lines.shift();
    const last = lines.at(-1)?.text.trim() ?? "";
    if (
      last.length >= fence[1].length &&
      [...last].every((character) => character === fence[1][0])
    )
      lines.pop();
  }
  const values = visible.split("\n");
  if (lines.length !== values.length) return null;
  const map: BoundaryMap = [];
  for (let index = 0; index < values.length; index++) {
    const line = lines[index],
      value = values[index];
    const prefix = line.text.length - value.length;
    if (
      prefix < 0 ||
      !line.text.endsWith(value) ||
      !/^[ \t]*$/.test(line.text.slice(0, prefix))
    )
      return null;
    const part = textBoundaryMap(value, value, line.start + prefix, false);
    if (!part) return null;
    if (index) map.push(line.start + prefix);
    map.push(...(index ? part.slice(1) : part));
    if (index < values.length - 1 && line.end === line.start + line.text.length)
      return null;
  }
  return map;
}
const positionKey = (node: MarkdownNode) =>
  `${node.position?.start.offset}:${node.position?.end.offset}`;
export function markdownSourcePlugins(source: string) {
  const codeMaps = new Map<
    string,
    { value: string; map: BoundaryMap | null }
  >();
  const remark = () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (
        (node.type === "inlineCode" || node.type === "code") &&
        start !== undefined &&
        end !== undefined
      ) {
        const value =
          node.type === "inlineCode"
            ? (node.value ?? "").replace(/\r\n?|\n/g, " ")
            : (node.value ?? "");
        codeMaps.set(positionKey(node), {
          value,
          map:
            node.type === "inlineCode"
              ? codeSpanMap(source.slice(start, end), value, start)
              : codeBlockMap(source.slice(start, end), value, start),
        });
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
  const rehype = () => (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      parent.children = parent.children?.map((child) => {
        if (child.type !== "text") {
          visit(child);
          return child;
        }
        const value = child.value ?? "";
        let map: BoundaryMap | null = null;
        const start = child.position?.start.offset,
          end = child.position?.end.offset;
        if (start !== undefined && end !== undefined)
          map = textBoundaryMap(source.slice(start, end), value, start);
        if (!map && parent.tagName === "code") {
          const code = codeMaps.get(positionKey(parent));
          if (code?.map && value === code.value) map = code.map;
          else if (code?.map && value === code.value + "\n")
            map = [...code.map, null];
        }
        // Structural whitespace cannot be wrapped in spans (e.g. a table body).
        if (!map && !value.trim()) return child;
        const properties: Record<string, unknown> = {
          "data-mr-visible": value,
        };
        if (map) properties["data-mr-map"] = JSON.stringify(map);
        else properties["data-mr-unmapped"] = "true";
        return {
          type: "element",
          tagName: "span",
          properties,
          children: [child],
        };
      });
    };
    visit(tree);
  };
  return { remark, rehype };
}

export function mappedMarkdownSelection(
  element: HTMLElement,
  source: string,
  selection: Selection,
): { start: number; end: number; exact: string; visible: string } | null {
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const selectionStart = before.toString().length;
  const visible = range.toString(),
    selectionEnd = selectionStart + visible.length;
  if (!visible.trim()) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0,
    start: number | null = null,
    end: number | null = null;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    const value = text.data,
      from = Math.max(0, selectionStart - offset),
      to = Math.min(value.length, selectionEnd - offset);
    if (to > from) {
      const span = text.parentElement?.closest<HTMLElement>(
        "[data-mr-map],[data-mr-unmapped]",
      );
      if (!span || !element.contains(span)) {
        if (value.slice(from, to).trim()) return null;
      } else {
        if (
          span.dataset.mrVisible !== span.textContent ||
          span.childNodes.length !== 1 ||
          span.firstChild !== text
        )
          return null;
        let map: BoundaryMap;
        try {
          map = JSON.parse(span.dataset.mrMap ?? "null");
        } catch {
          return null;
        }
        if (!Array.isArray(map) || map.length !== value.length + 1) return null;
        const a = map[from],
          b = map[to];
        if (
          a === null ||
          b === null ||
          !Number.isInteger(a) ||
          !Number.isInteger(b) ||
          a < 0 ||
          b > source.length ||
          b < a ||
          (end !== null && a < end)
        )
          return null;
        if (start === null) start = a;
        end = b;
      }
    }
    offset += value.length;
  }
  if (start === null || end === null || end <= start) return null;
  return { start, end, exact: source.slice(start, end), visible };
}
