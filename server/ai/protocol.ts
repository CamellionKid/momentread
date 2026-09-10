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
