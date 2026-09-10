import type { Run } from "../../shared/contracts";
/** A run's creation time is not the reading date requested by the user. */
export function latestDailyRun(
  runs: Run[],
  bookId: string,
  date: string,
  timezone: string,
  capturedRunId?: string,
): Run | null {
  return (
    runs
      .map((run, index) => ({ run, index }))
      .filter(({ run }) => {
        if (run.bookId !== bookId || run.purpose !== "daily") return false;
        if (run.reportTarget)
          return (
            run.reportTarget.date === date &&
            run.reportTarget.timezone === timezone
          );
        if (run.id === capturedRunId) return true;
        // Old successful records contain an explicit target. Failed legacy runs do not.
        const result =
          run.status === "completed" &&
          run.result &&
          typeof run.result === "object"
            ? (run.result as { date?: unknown; timezone?: unknown })
            : null;
        return result?.date === date && result?.timezone === timezone;
      })
      .sort(
        (a, b) =>
          b.run.createdAt.localeCompare(a.run.createdAt) || b.index - a.index,
      )[0]?.run ?? null
  );
}
export const dailyFailureTitle = (status: Run["status"] | undefined) =>
  status === "interrupted"
    ? "本次总结生成已中断"
    : status === "cancelled"
      ? "本次总结生成已停止"
      : "本次总结生成失败";
