import { useEffect, useMemo, useRef, useState } from "react";
import type { Discussion } from "../../shared/contracts";
import { treeLayout } from "./model";
export function RouteRail({
  nodes,
  active,
  collapsed,
  onSelect,
  visible,
}: {
  nodes: Discussion[];
  active: string | null;
  collapsed: string[];
  onSelect: (id: string) => void;
  visible: boolean;
}) {
  const { points, width, height } = useMemo(
    () => treeLayout(nodes, collapsed, active),
    [nodes, collapsed, active],
  );
  const byId = new Map(points.map((point) => [point.id, point]));
  const rail = useRef<HTMLElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const reveal = () => {
      if (rail.current?.clientWidth)
        current.current?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    if (rail.current) observer.observe(rail.current);
    return () => observer.disconnect();
  }, [active, width, height, visible]);
  const place = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setTip({
      left: Math.max(12, Math.min(window.innerWidth - 212, rect.x - 84)),
      top: Math.max(8, rect.y - 65),
    });
  };
  return (
    <aside className="route-rail" ref={rail} aria-label="概念线路图">
      <div className="route-map" style={{ width, height }}>
        <svg
          className="route-lines"
          width={width}
          height={height}
          aria-hidden="true"
        >
          {points.length > 0 && (
            <path
              d={`M32 12 V${Math.max(...points.filter((p) => !p.parentId).map((p) => p.y)) + 38}`}
            />
          )}
          {points.map((point) => {
            const parent = point.parentId ? byId.get(point.parentId) : null;
            return parent ? (
              <path
                key={point.id}
                d={`M${parent.x} ${parent.y} C${parent.x + 34} ${parent.y},${point.x - 34} ${point.y},${point.x} ${point.y}`}
              />
            ) : null;
          })}
        </svg>
        {points.map((point) => (
          <div
            className="route-point-wrap"
            style={{ left: point.x, top: point.y }}
            key={point.id}
            onMouseEnter={(e) => place(e.currentTarget)}
            onFocus={(e) => place(e.currentTarget)}
          >
            <button
              className={`route-point ${point.id === active ? "active" : ""} ${point.folded ? "folded" : ""}`}
              ref={point.id === active ? current : undefined}
              aria-label={`${point.title}${point.needsMerge ? "，待合并更新" : ""}`}
              aria-current={point.id === active ? "true" : undefined}
              onClick={() => onSelect(point.id)}
            >
              <span />
            </button>
            <div role="tooltip" className="node-tooltip" style={tip}>
              <strong>{point.title}</strong>
              <span>
                {point.folded
                  ? "已折叠"
                  : point.needsMerge
                    ? "待合并更新"
                    : point.parentId
                      ? "概念讨论"
                      : "选段解析"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
