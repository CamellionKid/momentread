interface ContextView {
  kind: "structured";
  origin: string;
  segments: { chapter: string; exact: string }[];
}
export function readableConceptContext(
  context: string,
): ContextView | { kind: "text"; text: string } {
  let data: unknown;
  try {
    data = JSON.parse(context);
  } catch {
    return { kind: "text", text: context };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return {
      kind: "text",
      text: typeof data === "string" ? data : "暂无可读的来源说明。",
    };
  const record = data as Record<string, unknown>,
    origin = record.origin as { exact?: unknown; displayText?: unknown } | null,
    source = record.source as { segments?: unknown } | null;
  const segments = Array.isArray(source?.segments)
    ? source.segments.flatMap((item) =>
        item && typeof item === "object" && typeof item.exact === "string"
          ? [
              {
                chapter:
                  typeof item.chapter === "string" ? item.chapter : "正文选段",
                exact: item.exact,
              },
            ]
          : [],
      )
    : [];
  return {
    kind: "structured",
    origin:
      typeof origin?.displayText === "string"
        ? origin.displayText
        : typeof origin?.exact === "string"
          ? origin.exact
          : "",
    segments,
  };
}
export function ConceptContext({ context }: { context: string }) {
  const view = readableConceptContext(context);
  if (view.kind === "text")
    return <p className="quiet-note product-prewrap">{view.text}</p>;
  return (
    <div className="product-concept-context">
      {view.origin && (
        <>
          <small>父讨论中的触发选词</small>
          <p>{view.origin}</p>
        </>
      )}
      {view.segments.map((segment, index) => (
        <div key={index}>
          <small>{segment.chapter}</small>
          <blockquote>{segment.exact}</blockquote>
        </div>
      ))}
      {!view.origin && !view.segments.length && (
        <p className="quiet-note">暂无可读的来源说明。</p>
      )}
    </div>
  );
}
