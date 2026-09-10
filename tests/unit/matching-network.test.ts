import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
vi.mock('node:http',()=>({request:mocks.request}));
vi.mock('node:https',()=>({request:mocks.request}));
import {fetchPublicDocument,MAX_SOURCE_BYTES} from '../../server/matching/network';

type Reply={status?:number;headers?:Record<string,string>;body?:string;error?:Error};
function setup(replies:Reply[]){
  mocks.lookup.mockResolvedValue([{address:'8.8.8.8',family:4}]);
  mocks.request.mockImplementation((_url,options,callback)=>{
    const request=new EventEmitter() as EventEmitter&{end:()=>void;destroy:(error?:Error)=>void};
    request.end=()=>queueMicrotask(()=>{
      const reply=replies.shift();if(!reply)throw new Error('Unexpected request');
      if(reply.error){request.emit('error',reply.error);request.emit('close');return;}
      const response=Readable.from([Buffer.from(reply.body??'')]) as Readable&{statusCode:number;headers:Record<string,string>};
      response.statusCode=reply.status??200;response.headers={'content-type':'text/html;charset=utf-8',...reply.headers};response.on('close',()=>request.emit('close'));
      callback(response);
    });
    request.destroy=(error)=>{if(error)request.emit('error',error);request.emit('close');};
    options.lookup('example.org',{all:true},(error:unknown,addresses:unknown)=>{expect(error).toBeNull();expect(addresses).toEqual([{address:new URL(_url).hostname==='cloudflare-dns.com'?'1.1.1.1':'8.8.8.8',family:4}]);});
    return request;
  });
}
afterEach(()=>{vi.resetAllMocks();vi.useRealTimers();});
describe('bounded source HTTP retrieval',()=>{
  it('pins DNS, strips scripts, and extracts the actual body',async()=>{
    setup([{body:'<p>Actual source &amp; evidence.</p><script>fabricated quote</script>'}]);
    expect(await fetchPublicDocument('https://example.org/chapter')).toEqual({url:'https://example.org/chapter',contentType:'text/html;charset=utf-8',text:'Actual source & evidence.'});
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it('rechecks every redirect before any request to a private destination',async()=>{
    setup([{status:302,headers:{location:'http://127.0.0.1/private'}}]);
    await expect(fetchPublicDocument('http://example.org/source')).rejects.toMatchObject({code:'SOURCE_URL_BLOCKED'});
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('resolves fake-IP through the fixed pinned DoH endpoint then pins the public source address',async()=>{
    setup([{headers:{'content-type':'application/dns-json'},body:JSON.stringify({Status:0,Answer:[{type:1,data:'8.8.8.8'}]})},{body:'<p>Verified source.</p>'}]);mocks.lookup.mockResolvedValue([{address:'198.18.2.3',family:4}]);
    expect((await fetchPublicDocument('https://example.org/source')).text).toBe('Verified source.');
    expect(String(mocks.request.mock.calls[0][0])).toBe('https://cloudflare-dns.com/dns-query?name=example.org&type=A');expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it('rejects a DoH private result without issuing a source request',async()=>{
    setup([{body:JSON.stringify({Status:0,Answer:[{type:1,data:'127.0.0.1'}]})}]);mocks.lookup.mockResolvedValue([{address:'198.18.2.3',family:4}]);
    await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_DNS_FAILED'});expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('rejects DNS rebinding to a private answer on the next redirect',async()=>{
    setup([{status:302,headers:{location:'https://other.example.org/chapter'}}]);
    mocks.lookup.mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
    await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_URL_BLOCKED'});expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('rejects HTTPS downgrades and excessive redirects',async()=>{
    setup([{status:301,headers:{location:'http://example.org/plain'}}]);
    await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_REDIRECT_BLOCKED'});
    setup(Array(5).fill({status:302,headers:{location:'/again'}}));
    await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_REDIRECT_FAILED'});
  });
  it.each([403,404,429,500])('distinguishes actual HTTP %i retrieval failure',async status=>{
    setup([{status}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_HTTP_FAILED'});
  });
  it('rejects non-text or compressed content instead of treating it as original text',async()=>{
    setup([{headers:{'content-type':'application/pdf'}}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_FORMAT_UNSUPPORTED'});
    setup([{headers:{'content-encoding':'gzip'}}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_FORMAT_UNSUPPORTED'});
  });
  it('enforces size based on both headers and streamed bytes',async()=>{
    setup([{headers:{'content-length':String(MAX_SOURCE_BYTES+1)}}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_TOO_LARGE'});
    setup([{body:'x'.repeat(MAX_SOURCE_BYTES+1)}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_TOO_LARGE'});
  });
  it('times out stalled DNS before initiating an HTTP request',async()=>{
    vi.useFakeTimers();mocks.lookup.mockImplementation(()=>new Promise(()=>{}));
    const pending=expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(15000);await pending;expect(mocks.request).not.toHaveBeenCalled();
  });
  it('times out a stalled connection and destroys the pending request',async()=>{
    vi.useFakeTimers();mocks.lookup.mockResolvedValue([{address:'8.8.8.8',family:4}]);
    const request=new EventEmitter() as EventEmitter&{end:()=>void;destroy:(error:Error)=>void};request.end=()=>{};request.destroy=vi.fn(error=>{request.emit('error',error);request.emit('close');});mocks.request.mockReturnValue(request);
    const pending=expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(15000);await pending;expect(request.destroy).toHaveBeenCalledTimes(1);
  });
  it('rejects empty source bodies',async()=>{setup([{body:'<script>only script</script>'}]);await expect(fetchPublicDocument('https://example.org/source')).rejects.toMatchObject({code:'SOURCE_EMPTY'});});
});
