import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  BookState,
  ReadingPosition,
  RunEvent,
  Workspace,
} from "../../shared/contracts";
import { isActiveRun } from "./model";
export interface PendingPermission {
  runId: string;
  discussionId: string;
  requestId: string;
  toolName: string;
  description: string;
  input: unknown;
}
export function useWorkspace(onError: (message: string) => void) {
  const [state, setState] = useState<BookState | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const currentBook = useRef<string | null>(null);
  const requestSeq = useRef(0);
  const dirty = useRef(
    new Map<string, { draft?: string; scrollTop?: number }>(),
  );
  const workspaceDirty = useRef<Partial<Workspace>>({});
  const queue = useRef<Promise<void>>(Promise.resolve());
  const err = useRef(onError);
  err.current = onError;
  const merge = useCallback((next: BookState) => {
    const value = {
      ...next,
      workspace: { ...next.workspace, ...workspaceDirty.current },
      discussions: next.discussions.map((d) => ({
        ...d,
        ...dirty.current.get(d.id),
      })),
    };
    setState(value);
  }, []);
  const refresh = useCallback(async () => {
    const id = currentBook.current;
    if (!id) return;
    const seq = ++requestSeq.current;
    try {
      const next = await api.state(id);
      if (currentBook.current === id && seq === requestSeq.current) merge(next);
    } catch (error) {
      if (currentBook.current === id)
        err.current(
          error instanceof Error ? error.message : "无法同步书籍状态。",
        );
    }
  }, [merge]);
  const flush = useCallback(async () => {
    const task = async () => {
      while (true) {
        const entries = [...dirty.current.entries()].map(
          ([id, value]) => [id, { ...value }] as const,
        );
        const patch = { ...workspaceDirty.current };
        const bookId = currentBook.current;
        if (!entries.length && !Object.keys(patch).length) return;
        setSaveStatus("saving");
        try {
          for (const [id, value] of entries) {
            await api.discussion(id, value);
            const current = dirty.current.get(id);
            if (current) {
              const remaining = { ...current };
              for (const key of ["draft", "scrollTop"] as const)
                if (current[key] === value[key]) delete remaining[key];
              if (Object.keys(remaining).length)
                dirty.current.set(id, remaining);
              else dirty.current.delete(id);
            }
          }
          if (bookId && Object.keys(patch).length) {
            await api.workspace(bookId, patch);
            for (const key of Object.keys(patch) as (keyof Workspace)[])
              if (workspaceDirty.current[key] === patch[key])
                delete workspaceDirty.current[key];
          }
          setSaveStatus(
            dirty.current.size || Object.keys(workspaceDirty.current).length
              ? "saving"
              : "saved",
          );
        } catch (error) {
          setSaveStatus("error");
          throw error;
        }
        if (!dirty.current.size && !Object.keys(workspaceDirty.current).length)
          return;
      }
    };
    const next = queue.current.catch(() => {}).then(task);
    queue.current = next;
    return next;
  }, []);
  const open = useCallback(
    async (id: string) => {
      await flush();
      setLoading(true);
      const seq = ++requestSeq.current;
      const previousBook = currentBook.current;
      currentBook.current = id;
      workspaceDirty.current = {};
      setPermissions([]);
      try {
        const next = await api.state(id);
        if (seq === requestSeq.current && currentBook.current === id) {
          merge(next);
          localStorage.setItem("momentread.currentBook", id);
        }
      } catch (error) {
        if (currentBook.current === id) {
          currentBook.current = previousBook;
          setLoading(false);
        }
        throw error;
      } finally {
        if (currentBook.current === id) setLoading(false);
      }
    },
    [flush, merge],
  );
  const edit = useCallback(
    (id: string, patch: { draft?: string; scrollTop?: number }) => {
      dirty.current.set(id, { ...dirty.current.get(id), ...patch });
      setState((old) =>
        old
          ? {
              ...old,
              discussions: old.discussions.map((d) =>
                d.id === id ? { ...d, ...patch } : d,
              ),
            }
          : old,
      );
      setSaveStatus("saving");
      setDraftVersion((v) => v + 1);
    },
    [],
  );
  const workspace = useCallback(
    (
      patch: Partial<
        Pick<
          Workspace,
          "position" | "activeDiscussionId" | "collapsed" | "fontSize"
        >
      >,
    ) => {
      workspaceDirty.current = { ...workspaceDirty.current, ...patch };
      setState((old) =>
        old ? { ...old, workspace: { ...old.workspace, ...patch } } : old,
      );
      setSaveStatus("saving");
      setDraftVersion((v) => v + 1);
    },
    [],
  );
  const activate = useCallback(
    async (id: string | null) => {
      await flush();
      const bookId = currentBook.current;
      if (!bookId) return;
      const saved = await api.workspace(bookId, { activeDiscussionId: id });
      if (currentBook.current === bookId)
        setState((old) =>
          old
            ? { ...old, workspace: { ...saved, ...workspaceDirty.current } }
            : old,
        );
    },
    [flush],
  );
  const relocate = useCallback(
    (position: ReadingPosition) => workspace({ position }),
    [workspace],
  );
  useEffect(() => {
    if (!draftVersion) return;
    const timer = setTimeout(() => {
      void flush().catch((error) =>
        err.current(
          error instanceof Error ? error.message : "保存失败，请重试。",
        ),
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [draftVersion, flush]);
  useEffect(() => {
    const savePending = () => {
      for (const [id, patch] of dirty.current)
        void fetch(`/api/discussions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          keepalive: true,
        }).catch(() => {});
      if (currentBook.current && Object.keys(workspaceDirty.current).length)
        void fetch(`/api/books/${currentBook.current}/workspace`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workspaceDirty.current),
          keepalive: true,
        }).catch(() => {});
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size || Object.keys(workspaceDirty.current).length) {
        savePending();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", savePending);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("pagehide", savePending);
    };
  }, []);
  const activeRuns = (state?.runs ?? []).filter(isActiveRun);
  const runIds = activeRuns
    .map((run) => run.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!runIds) return;
    const timer = setInterval(() => {
      void refresh();
    }, 700);
    return () => clearInterval(timer);
  }, [runIds, refresh]);
  useEffect(() => {
    setPermissions((previous) =>
      previous.filter((p) => runIds.split(",").includes(p.runId)),
    );
    const streams = runIds
      ? runIds.split(",").map((id) => {
          const stream = new EventSource(`/api/runs/${id}/events?after=0`);
          const consume = (raw: Event) => {
            try {
              const event = JSON.parse((raw as MessageEvent).data) as RunEvent;
              if (event.runId !== id) return;
              if (event.type === "permission_required") {
                const item: PendingPermission = {
                  runId: id,
                  discussionId: event.discussionId,
                  requestId: String(event.data.requestId),
                  toolName: String(event.data.toolName ?? "网络查询"),
                  description: String(
                    event.data.description ?? "允许本次网络访问？",
                  ),
                  input: event.data.input,
                };
                setPermissions((previous) => [
                  ...previous.filter((p) => p.requestId !== item.requestId),
                  item,
                ]);
              }
              if (event.type === "permission_resolved")
                setPermissions((previous) =>
                  previous.filter(
                    (p) => p.requestId !== String(event.data.requestId),
                  ),
                );
              if (["completed", "failed", "cancelled"].includes(event.type))
                void refresh();
            } catch {
              /* Polling remains authoritative when a stream packet is incomplete. */
            }
          };
          for (const type of [
            "message",
            "run",
            "initialized",
            "text_delta",
            "permission_required",
            "permission_resolved",
            "completed",
            "cancelled",
            "failed",
          ])
            stream.addEventListener(type, consume);
          return stream;
        })
      : [];
    return () => streams.forEach((stream) => stream.close());
  }, [runIds, refresh]);
  return {
    state,
    setState,
    loading,
    open,
    refresh,
    edit,
    workspace,
    activate,
    relocate,
    flush,
    saveStatus,
    permissions,
  };
}
