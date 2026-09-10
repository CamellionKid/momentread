import {inflateRawSync} from 'node:zlib';
import {AppError} from '../../shared/contracts/index';

export const EPUB_LIMITS = {compressed: 128 * 1024 * 1024, expanded: 256 * 1024 * 1024, entry: 64 * 1024 * 1024, count: 10000};
export const BACKUP_LIMITS = {compressed: 512 * 1024 * 1024, expanded: 1024 * 1024 * 1024, entry: 256 * 1024 * 1024, count: 20000};
type Limits = typeof EPUB_LIMITS;
const decoder = new TextDecoder('utf-8', {fatal: true});
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  let value = i;
  for (let j = 0; j < 8; j++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function assertArchivePath(name: string): void {
  if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.') || name.includes('//')) {
    throw new AppError('UNSAFE_ARCHIVE_PATH', '压缩包包含不安全的文件路径。');
  }
}

/** Validate every central-directory entry before allocating inflated output. */
export function readArchive(bytes: Uint8Array, limits: Limits = EPUB_LIMITS): Map<string, Uint8Array> {
  if (bytes.length > limits.compressed) throw new AppError('ARCHIVE_TOO_LARGE', '压缩包超过当前支持的大小。', 413);
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) {eocd = p; break;}
    }
    if (eocd < 0) throw new Error('Missing central directory');
    const count = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    let offset = view.getUint32(eocd + 16, true);
    if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || view.getUint16(eocd + 8, true) !== count || count === 65535 || offset + centralSize !== eocd || count > limits.count) throw new Error('Unsupported or oversized ZIP directory');
    const entries: Array<{name: string; start: number; size: number; expanded: number; method: number; crc: number}> = [];
    const names = new Set<string>();
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid entry');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true);
      const size = view.getUint32(offset + 20, true);
      const expanded = view.getUint32(offset + 24, true);
      const nameSize = view.getUint16(offset + 28, true);
      const extraSize = view.getUint16(offset + 30, true);
      const commentSize = view.getUint16(offset + 32, true);
      const external = view.getUint32(offset + 38, true);
      const local = view.getUint32(offset + 42, true);
      const nameEnd = offset + 46 + nameSize;
      if (nameEnd + extraSize + commentSize > eocd) throw new Error('Truncated entry');
      const name = decoder.decode(bytes.subarray(offset + 46, nameEnd));
      assertArchivePath(name);
      if (names.has(name) || (external >>> 16 & 0xf000) === 0xa000) throw new Error('Duplicate or symbolic-link entry');
      names.add(name);
      total += expanded;
      if (expanded > limits.entry || total > limits.expanded) throw new AppError('ARCHIVE_TOO_LARGE', '解压后内容超过当前支持的大小。', 413);
      if ((flags & 1) || ![0, 8].includes(method) || size === 0xffffffff || expanded === 0xffffffff || local + 30 > view.byteLength || view.getUint32(local, true) !== 0x04034b50) throw new Error('Unsupported ZIP entry');
      const localNameSize = view.getUint16(local + 26, true);
      const start = local + 30 + localNameSize + view.getUint16(local + 28, true);
      if (decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags || start + size > view.getUint32(eocd + 16, true)) throw new Error('Local header mismatch');
      entries.push({name, start, size, expanded, method, crc});
      offset = nameEnd + extraSize + commentSize;
    }
    if (offset !== eocd) throw new Error('Directory length mismatch');
    const result = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const compressed = bytes.subarray(entry.start, entry.start + entry.size);
      // Enforce the bound in the inflater, not merely in ZIP metadata: an
      // archive can lie about its expanded size in the central directory.
      const content = entry.method === 0 ? compressed.slice() : inflateRawSync(compressed, {maxOutputLength: Math.max(1, entry.expanded)});
      if (content.length !== entry.expanded || crc32(content) !== entry.crc) throw new Error('Entry data integrity failure');
      if (!entry.name.endsWith('/')) result.set(entry.name, content);
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_ARCHIVE', '压缩包损坏、加密或格式不受支持。');
  }
}
