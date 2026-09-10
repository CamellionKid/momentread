import type { RunEvent } from "../../shared/contracts";

export interface RunRetry {
  runId: string;
  discussionId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorCategory: string;
  status?: number;
}

const categories: Record<string, string> = {
  rate_limit: "调用频率或额度受限",
  overloaded: "服务繁忙",
  server_error: "服务暂时异常",
  authentication_failed: "认证未通过",
  oauth_org_not_allowed: "组织访问未获授权",
  account_on_hold: "账户暂时停用",
  billing_error: "账户额度或计费受限",
  invalid_request: "请求被服务拒绝",
  model_not_found: "模型暂不可用",
  max_output_tokens: "达到输出上限",
  cloud_credential_error: "云服务认证不可用",
  no_response: "服务未及时响应",
  access_denied: "服务拒绝访问",
  unknown: "连接暂时未完成",
};

export function readRunRetry(event: RunEvent): RunRetry | null {
  if (event.type !== "retrying") return null;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  const category = event.data.errorCategory;
  const status = number(event.data.status);
  return {
    runId: event.runId,
    discussionId: event.discussionId,
    attempt: number(event.data.attempt),
    maxRetries: number(event.data.maxRetries),
    delayMs: number(event.data.delayMs),
    errorCategory:
      typeof category === "string" && Object.hasOwn(categories, category)
        ? category
        : "unknown",
    ...(status >= 400 && status <= 599 ? { status } : {}),
  };
}

export function RunRetryNotice({ retry }: { retry?: RunRetry }) {
  if (!retry) return null;
  return (
    <p className="product-retry-notice" role="status">
      AI 连接正在重试
      {retry.attempt > 0 &&
        `：第 ${retry.attempt}${retry.maxRetries > 0 ? ` / ${retry.maxRetries}` : ""} 次`}
      。{categories[retry.errorCategory] || categories.unknown}
      {retry.status && `（${retry.status}）`}。
      {retry.delayMs > 0 &&
        `本轮等待约 ${Math.ceil(retry.delayMs / 1000)} 秒。`}
    </p>
  );
}
