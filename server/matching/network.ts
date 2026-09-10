import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import sanitizeHtml from 'sanitize-html';
import {AppError} from '../../shared/contracts/index';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
export type Lookup = (hostname: string) => Promise<Array<{address: string; family: number}>>;
export type RetrievedDocument = {url: string; text: string; contentType: string};

/** Only globally routed addresses are eligible; DNS answers are pinned per hop. */
export function isPublicAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const first = parseInt(address.split(':')[0], 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3fff) return false;
  const second = parseInt(address.split(':')[1] || '0', 16);
  return !(first === 0x2001 && (second === 0 || second === 0xdb8 || second === 0x10 || second === 0x20));
}

export function isFakeIPAddress(address:string):boolean {
  if(isIP(address)!==4)return false;const [a,b]=address.split('.').map(Number);return a===198&&(b===18||b===19);
}

/** Fixed resolver, pinned IP and certificate hostname. Never supplied by candidates. */
export async function trustedDohLookup(hostname:string):Promise<Array<{address:string;family:number}>> {
  const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',hostname);url.searchParams.set('type','A');
  const body=await new Promise<string>((resolve,reject)=>{
    const request=httpsRequest(url,{headers:{'Accept':'application/dns-json','User-Agent':'MomentRead/0.1 source-verification'},
      lookup:((_host:string,options:unknown,callback:(...args:any[])=>void)=>{if(typeof options==='object'&&options!==null&&'all' in options&&options.all)callback(null,[{address:'1.1.1.1',family:4}]);else callback(null,'1.1.1.1',4);}) as any,
    },res=>{
      if(res.statusCode!==200){res.resume();reject(new AppError('SOURCE_DNS_FAILED','可信 DNS 查询失败，未读取原著来源。',502,true));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){res.destroy();reject(new AppError('SOURCE_DNS_FAILED','可信 DNS 响应无效。',502));}else chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));res.on('error',reject);
    });
    const timer=setTimeout(()=>request.destroy(new AppError('SOURCE_DNS_FAILED','可信 DNS 查询超时。',504,true)),5000);request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end();
  });
  try{
    const result=JSON.parse(body) as {Status:unknown;Answer?:Array<{type?:unknown;data?:unknown}>};
    if(result.Status!==0||!Array.isArray(result.Answer)||result.Answer.length>50)throw new Error('Invalid DNS result');
    const addresses=result.Answer.filter(answer=>answer.type===1&&typeof answer.data==='string').map(answer=>({address:answer.data as string,family:4}));
    if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new Error('No public answer');
    return addresses;
  }catch{throw new AppError('SOURCE_DNS_FAILED','可信 DNS 未返回可验证的公开地址，未读取原著来源。',502,true);}
}

export async function publicTarget(input: string, lookup: Lookup = hostname => dnsLookup(hostname, {all: true, verbatim: true}), resolveFake:Lookup=trustedDohLookup) {
  let url: URL;
  try {url = new URL(input);} catch {throw new AppError('SOURCE_URL_INVALID', '原著来源地址无效。');}
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port)) ||
    !host || host === 'localhost' || /\.(localhost|local|internal|home|lan|invalid)$/.test(host)) {
    throw new AppError('SOURCE_URL_BLOCKED', '仅允许公开 HTTP 或 HTTPS 原著来源。');
  }
  let addresses = isIP(host) ? [{address: host, family: isIP(host)}] : await lookup(host);
  // A hostname exclusively mapped to this reserved range identifies the local
  // TUN fake-IP resolver. Literal addresses and other private answers never fall back.
  if(!isIP(host)&&addresses.length&&addresses.every(item=>isFakeIPAddress(item.address)))addresses=await resolveFake(host);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new AppError('SOURCE_URL_BLOCKED', '原著来源解析到非公开地址，未发起读取。');
  url.hash = '';
  return {url, address: addresses[0]};
}

export function normalizeText(text: string): string {return text.normalize('NFC').replace(/\s+/gu, ' ').trim();}
export function htmlText(html: string): string {
  const clean = sanitizeHtml(html.replace(/<\/(?:p|div|h[1-6]|li|td|tr|section|article|blockquote)>|<br\s*\/?\s*>/gi, '$& '), {
    allowedTags: [], allowedAttributes: {}, nonTextTags: ['script','style','textarea','noscript','template'],
  });
  return normalizeText(clean.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string,string> = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  }));
}

/** No browser, scripts, cookies, proxy credentials, or automatic redirects. */
export async function fetchPublicDocument(input: string): Promise<RetrievedDocument> {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = input;
  for (let redirect = 0; redirect <= 4; redirect++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(1, deadline - Date.now());
    const target = await Promise.race([
      publicTarget(current),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new AppError('SOURCE_TIMEOUT', '原著来源读取超时。', 504, true)), remaining);}),
    ]).finally(() => clearTimeout(timer));
    if (Date.now() >= deadline) throw new AppError('SOURCE_TIMEOUT', '原著来源读取超时。', 504, true);
    const response = await new Promise<{status: number; location?: string; type: string; bytes: Buffer}>((resolve, reject) => {
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
        method: 'GET', headers: {'User-Agent':'MomentRead/0.1 source-verification','Accept':'text/html,application/xhtml+xml,text/plain','Accept-Encoding':'identity'},
        lookup: ((_hostname: string, options: unknown, callback: (...args: any[]) => void) => {
          if (typeof options === 'object' && options !== null && 'all' in options && options.all) callback(null, [target.address]);
          else callback(null, target.address.address, target.address.family);
        }) as any,
      }, res => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        if (status >= 300 && status < 400) {res.resume(); resolve({status,location:res.headers.location,type,bytes:Buffer.alloc(0)}); return;}
        if (status < 200 || status >= 300) {res.resume(); reject(new AppError('SOURCE_HTTP_FAILED', `原著来源返回 HTTP ${status}，未取得正文。`, 502, true)); return;}
        if (!/^(text\/(html|plain)|application\/xhtml\+xml)(?:;|$)/.test(type) || !['identity',''].includes(String(res.headers['content-encoding'] ?? ''))) {
          res.resume(); reject(new AppError('SOURCE_FORMAT_UNSUPPORTED', '此来源不是可直接核对的 HTML 或纯文本。')); return;
        }
        if (Number(res.headers['content-length'] ?? 0) > MAX_SOURCE_BYTES) {res.destroy(); reject(new AppError('SOURCE_TOO_LARGE', '原著网页超过 2 MB，请提供较小的章节页面或本地原著。', 413)); return;}
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_SOURCE_BYTES) {res.destroy(); reject(new AppError('SOURCE_TOO_LARGE', '原著网页超过 2 MB，请提供较小的章节页面或本地原著。', 413));}
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({status,type,bytes:Buffer.concat(chunks)}));
        res.on('error', reject);
      });
      const timeout = setTimeout(() => request.destroy(new AppError('SOURCE_TIMEOUT', '原著来源读取超时。', 504, true)), Math.max(1, deadline - Date.now()));
      request.on('close', () => clearTimeout(timeout)); request.on('error', reject); request.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirect === 4) throw new AppError('SOURCE_REDIRECT_FAILED', '原著来源重定向次数过多或地址缺失。', 502);
      const next = new URL(response.location, target.url);
      if (target.url.protocol === 'https:' && next.protocol !== 'https:') throw new AppError('SOURCE_REDIRECT_BLOCKED', '原著来源尝试跳转到不安全连接。');
      current = next.href; continue;
    }
    const charset = response.type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? 'utf-8';
    let raw: string;
    try {raw = new TextDecoder(charset, {fatal: true}).decode(response.bytes);} catch {throw new AppError('SOURCE_ENCODING_UNSUPPORTED', '无法可靠解码原著来源，未将乱码作为证据。');}
    const text = response.type.startsWith('text/plain') ? normalizeText(raw) : htmlText(raw);
    if (!text) throw new AppError('SOURCE_EMPTY', '原著来源没有可核对的正文。');
    return {url:target.url.href,text,contentType:response.type};
  }
  throw new AppError('SOURCE_REDIRECT_FAILED', '原著来源重定向失败。');
}
