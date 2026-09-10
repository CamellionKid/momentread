/** A missing iframe load event must become a recoverable error, never an endless spinner. */
export async function waitForChapter<T>(loading: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([loading, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('章节加载超时。请重新加载；若仍未显示，请使用 Chrome 打开 MomentRead。')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
