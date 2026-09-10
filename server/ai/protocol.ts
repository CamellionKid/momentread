import {StringDecoder} from 'node:string_decoder';

/** NDJSON is byte-framed: decoding each Buffer separately corrupts split CJK. */
export class JsonLineDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private accept: (message: Record<string, any>) => void, private maximum = 8 * 1024 * 1024) {}
  push(chunk: Buffer) { this.buffer += this.decoder.write(chunk); this.drain(false); }
  end() { this.buffer += this.decoder.end(); this.drain(true); }
  private drain(final: boolean) {
    if (Buffer.byteLength(this.buffer) > this.maximum) throw new Error('CLI_PROTOCOL_LIMIT');
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); this.parse(line);
    }
    if (final && this.buffer.trim()) { this.parse(this.buffer); this.buffer = ''; }
  }
  private parse(line: string) {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI_PROTOCOL_INVALID');
    this.accept(value as Record<string, any>);
  }
}

/** Streaming deltas and assistant snapshots describe the same message. */
export class TextAccumulator {
  text = '';
  private currentId = '';
  private streamed = new Map<string, string>();
  private snapshots = new Set<string>();
  consume(message: Record<string, any>): string {
    if (message.parent_tool_use_id) return '';
    let delta = '';
    if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') this.currentId = event.message?.id || `anonymous-${this.streamed.size}`;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = String(event.delta.text || '');
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') delta = String(event.content_block.text || '');
      if (delta) this.streamed.set(this.currentId, (this.streamed.get(this.currentId) || '') + delta);
    } else if (message.type === 'assistant') {
      const id = message.message?.id || this.currentId;
      if (this.snapshots.has(id)) return '';
      this.snapshots.add(id);
      const snapshot = (message.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('');
      const streamed = this.streamed.get(id) || '';
      if (!streamed) delta = snapshot;
      else if (snapshot.startsWith(streamed)) delta = snapshot.slice(streamed.length);
    }
    this.text += delta;
    return delta;
  }
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:sk-(?:ant-)?|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[credential]')
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(?:\/Users\/|\/home\/)[^\s"'<>]+/g, '[local-path]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[url]')
    .slice(0, 1200);
}

export type CliFailure = {code: string; message: string; errorCategory: string; status?: number};

/** Count explicit links in the CLI search-result body, excluding its query header
 * and reminder footer. Unknown formats remain unknown, never optimistic success. */
export function webSearchResultCount(content: unknown, query?: string): number | undefined {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  const expectedHeader = typeof query === 'string' ? `Web search results for query: "${query}"\n\n` : undefined;
  let body: string;
  if (expectedHeader && text.startsWith(expectedHeader)) body = text.slice(expectedHeader.length);
  else {
    const header = text.match(/^Web search results for query: "[^\n]*"\r?\n\r?\n/);
    if (!header) return undefined;
    body = text.slice(header[0].length);
  }
  body = body.split(/\r?\nREMINDER:/, 1)[0];
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) urls.add(url.href); } catch { /* not a result URL */ }
  };
  for (const match of body.matchAll(/^Links:\s*(\[[^\r\n]*\])/gm)) {
    try { const links: unknown = JSON.parse(match[1]); if (Array.isArray(links)) for (const link of links) if (link && typeof link === 'object') add(link.url); } catch { /* unsupported payload stays uncounted */ }
  }
  for (const match of body.matchAll(/\[[^\]\r\n]+\]\((https?:\/\/[^\s)]+)\)/g)) add(match[1]);
  return urls.size;
}

const errorMessages: Record<string, {code: string; message: string}> = {
  authentication_failed: {code: 'CLI_AUTH_REQUIRED', message: 'Claude 服务拒绝了认证，请检查既有登录或连接凭据后重试。'},
  oauth_org_not_allowed: {code: 'CLI_ACCESS_DENIED', message: '当前 Claude 账户未获组织授权，请检查账户访问权限。'},
  account_on_hold: {code: 'CLI_ACCOUNT_ON_HOLD', message: 'Claude 服务暂停了当前账户，请在服务账户中查看状态。'},
  billing_error: {code: 'CLI_BILLING_LIMIT', message: 'Claude 服务报告账户额度或计费限制，请在服务账户中查看额度状态。'},
  rate_limit: {code: 'CLI_RATE_LIMIT', message: 'Claude 服务达到调用频率或额度上限，请等待额度恢复后重试。'},
  overloaded: {code: 'CLI_SERVICE_OVERLOADED', message: 'Claude 服务当前繁忙，请稍后重试。'},
  invalid_request: {code: 'CLI_REQUEST_REJECTED', message: 'Claude 服务拒绝了这次请求，请缩短问题或检查连接配置。'},
  model_not_found: {code: 'CLI_MODEL_UNAVAILABLE', message: '当前配置的模型不可用，请检查现有服务的模型映射。'},
  server_error: {code: 'CLI_SERVICE_ERROR', message: 'Claude 服务返回内部错误，请稍后重试。'},
  max_output_tokens: {code: 'CLI_OUTPUT_LIMIT', message: 'AI 达到输出上限，已保留收到的内容，请缩小问题范围。'},
  cloud_credential_error: {code: 'CLI_CLOUD_AUTH_REQUIRED', message: 'Claude 的云服务认证不可用，请检查现有云凭据配置。'},
  no_response: {code: 'CLI_SERVICE_NO_RESPONSE', message: 'Claude 服务未及时响应，请检查连接后重试。'},
  access_denied: {code: 'CLI_ACCESS_DENIED', message: 'Claude 服务拒绝了访问，请检查现有账户或工具的访问权限。'},
  unknown: {code: 'CLI_RUN_FAILED', message: 'AI 运行未正常完成，请检查 Claude Code 登录和服务状态后重试。'},
};

/** Only called for CLI protocol errors, never for a model's ordinary answer. */
export function classifyCliFailure(error: unknown, status: unknown, diagnostic: unknown = ''): CliFailure {
  const raw = typeof diagnostic === 'string' ? diagnostic : '';
  let errorCategory = typeof error === 'string' && Object.hasOwn(errorMessages, error) ? error : 'unknown';
  let httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  if (!httpStatus) {
    const match = raw.match(/(?:Request rejected \(|API Error:\s*|HTTP\s+)(4\d\d|5\d\d)\b/i);
    if (match) httpStatus = Number(match[1]);
  }
  if (errorCategory === 'unknown') {
    if (httpStatus === 429) errorCategory = 'rate_limit';
    else if (httpStatus === 401 || /Not logged in|authentication[_ ]failed/i.test(raw)) errorCategory = 'authentication_failed';
    else if (httpStatus === 403) errorCategory = 'access_denied';
    else if (httpStatus === 529) errorCategory = 'overloaded';
    else if (httpStatus && httpStatus >= 500) errorCategory = 'server_error';
  }
  let message = errorMessages[errorCategory].message;
  if (errorCategory === 'rate_limit') {
    // Preserve only a strict numeric timestamp from the service, not raw prose.
    const reset = raw.match(/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\b/i)?.[1];
    if (reset) message += ` 服务提示恢复时间：${reset}。`;
  }
  return {code: errorMessages[errorCategory].code, message, errorCategory, ...(httpStatus ? {status: httpStatus} : {})};
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private readers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  push(value: T) { const reader = this.readers.shift(); if (reader) reader({value, done: false}); else this.values.push(value); }
  close() { this.ended = true; for (const reader of this.readers.splice(0)) reader({value: undefined, done: true}); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {next: () => {
      if (this.values.length) return Promise.resolve({value: this.values.shift()!, done: false});
      if (this.ended) return Promise.resolve({value: undefined, done: true});
      return new Promise(resolve => this.readers.push(resolve));
    }};
  }
}
