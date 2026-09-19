import {describe,expect,it} from 'vitest';
import {BODY_LIMITS,fileInput,jsonInput} from '../../server/request-body';

const limits={...BODY_LIMITS,epub:64,txt:16,backup:96,overhead:1024};
function upload(filename:string,count:number,declared?:number) {
  let pulls=0,cancelled=false;
  const header=Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const chunks=[header,...Array.from({length:count},()=>Buffer.alloc(8,120)),Buffer.from('\r\n--test-boundary--\r\n')];
  const body=new ReadableStream<Uint8Array>({pull(controller){const chunk=chunks[pulls++];if(chunk)controller.enqueue(chunk);else controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
  const request=new Request('http://localhost/api/books',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=test-boundary',...(declared===undefined?{}:{'content-length':String(declared)})},body,duplex:'half'} as RequestInit);
  return {request,get pulls(){return pulls;},get cancelled(){return cancelled;}};
}
describe('streamed request limits',()=>{
  it.each([['book','test.epub',8],['original','原著.txt',2],['original','original.epub',8],['backup','backup.zip',12]] as const)('accepts the exact %s / %s byte boundary',async(kind,filename,count)=>{
    expect(await fileInput(upload(filename,count).request,kind,limits)).toEqual({filename,bytes:Buffer.alloc(count*8,120)});
  });
  it.each([['book','test.epub'],['original','original.txt'],['original','original.epub'],['backup','backup.zip']] as const)('stops oversized chunked %s / %s before buffering the rest',async(kind,filename)=>{
    const input=upload(filename,100);
    await expect(fileInput(input.request,kind,limits)).rejects.toMatchObject({status:413});
    expect(input.pulls).toBeLessThan(50);expect(input.cancelled).toBe(true);
  });
  it('does not trust a falsely small Content-Length',async()=>{
    const input=upload('original.txt',100,1);
    await expect(fileInput(input.request,'original',limits)).rejects.toMatchObject({status:413});expect(input.cancelled).toBe(true);
  });
  it('rejects an oversized declared body before reading it',async()=>{
    const input=upload('test.epub',100,9999);
    await expect(fileInput(input.request,'book',limits)).rejects.toMatchObject({status:413});
    expect(input.pulls).toBe(0);expect(input.cancelled).toBe(true);
  });
  it('rejects missing boundaries, multiple files and non-file fields',async()=>{
    const form=new FormData();form.append('file',new File(['x'],'one.epub'));form.append('file',new File(['x'],'two.epub'));
    await expect(fileInput(new Request('http://localhost',{method:'POST',body:form}),'book')).rejects.toMatchObject({status:400});
    const fields=new FormData();fields.set('other','value');
    await expect(fileInput(new Request('http://localhost',{method:'POST',body:fields}),'book')).rejects.toMatchObject({status:400});
    await expect(fileInput(new Request('http://localhost',{method:'POST',headers:{'content-type':'multipart/form-data'},body:'invalid'}),'book')).rejects.toMatchObject({status:400});
  });
  it('rejects a binary part without a filename as a client error',async()=>{
    const request=new Request('http://localhost',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=test'},body:'--test\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\ndata\r\n--test--\r\n'});
    await expect(fileInput(request,'book')).rejects.toMatchObject({status:400});
  });
  it('counts JSON bytes without Content-Length and cancels immediately at the limit',async()=>{
    let pulls=0,cancelled=false;
    const body=new ReadableStream({pull(c){pulls++;c.enqueue(Buffer.alloc(65536,32));},cancel(){cancelled=true;}},{highWaterMark:0});
    const request=new Request('http://localhost',{method:'POST',body,duplex:'half'} as RequestInit);
    await expect(jsonInput(request)).rejects.toMatchObject({status:413});expect(pulls).toBe(17);expect(cancelled).toBe(true);
  });
});
