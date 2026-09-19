import {once} from 'node:events';
import {request} from 'node:http';
import {serve} from '@hono/node-server';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {BODY_LIMITS} from '../../server/request-body';
import {importSynthetic,makeHarness,type Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
describe('HTTP upload admission before parsing or persistence',()=>{
  it('returns 413 for a real unfinished chunked JSON upload without Content-Length',async()=>{
    const h=await makeHarness();opened.push(h);
    const server=serve({fetch:h.app.fetch,hostname:'127.0.0.1',port:0});await once(server,'listening');
    const port=(server.address() as {port:number}).port;
    try {
      const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{
        const upload=request({hostname:'127.0.0.1',port,path:'/api/analyses',method:'POST',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{
          let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>{resolve({status:response.statusCode!,body});upload.destroy();});
        });
        upload.on('error',reject);upload.setTimeout(3000,()=>upload.destroy(new Error('Server waited for an oversized upload to finish')));
        upload.write(Buffer.alloc(BODY_LIMITS.json+1,32));
        // Deliberately never end the upload: the server must reject mid-stream.
      });
      expect(result.status).toBe(413);expect(JSON.parse(result.body).error.code).toBe('FILE_TOO_LARGE');
      expect(h.store.list('discussions')).toEqual([]);expect(h.adapter.starts).toEqual([]);
    } finally {await new Promise<void>(resolve=>{server.close(()=>resolve());if('closeAllConnections' in server)server.closeAllConnections();});}
  });
  it('stops chunked TXT before library parsing and retains the existing book',async()=>{
    const h=await makeHarness();opened.push(h);const book=await importSynthetic(h);
    const importing=vi.spyOn(h.library,'importOriginal');let chunks=0,cancelled=false;
    const body=new ReadableStream<Uint8Array>({pull(controller){
      controller.enqueue(chunks++===0?Buffer.from('--limit\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n'):Buffer.alloc(65536,120));
    },cancel(){cancelled=true;}},{highWaterMark:0});
    const response=await h.app.request(new Request(`http://localhost/api/books/${book.id}/originals`,{method:'POST',headers:{'content-type':'multipart/form-data; boundary=limit'},body,duplex:'half'} as RequestInit));
    expect(response.status).toBe(413);expect(cancelled).toBe(true);expect(chunks).toBeLessThan(330);
    expect(importing).not.toHaveBeenCalled();expect(h.store.list('files')).toHaveLength(1);expect(h.store.list('books')).toEqual([book]);
  });
});
