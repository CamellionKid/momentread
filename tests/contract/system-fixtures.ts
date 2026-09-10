import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipSync, strToU8} from 'fflate';
import {createApp} from '../../server/app';
import {createStore} from '../../server/storage';
import {createBookLibrary} from '../../server/books';
import {createLearningService} from '../../server/learning';
import {createMatchingService} from '../../server/matching';
import type {Book, BookState, Run, RunEvent, TextReference} from '../../shared/contracts';
import {BookStateResponseSchema} from '../../shared/contracts/http';
import type {ClaudeAdapter, RunHandle, StartRun} from '../../shared/contracts/ports';

// Entirely synthetic; repeated text is deliberate. No user EPUB is read.
export const repeatedText = '合成句子：同一术语可以有不同语境。';
const xml = (value:string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
export function syntheticEpub(title = '系统测试书'):Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'EPUB/package.opf': strToU8(`<?xml version="1.0"?><package version="3.0" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">synthetic-${randomUUID()}</dc:identifier><dc:title>${xml(title)}</dc:title><dc:creator>合成作者</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-09-10T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter1"/><itemref idref="chapter2"/></spine></package>`),
    'EPUB/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章</a></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>'),
    ...Object.fromEntries([1,2].map(n => [`EPUB/chapter${n}.xhtml`, strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${n}章</title></head><body><p id="before">章节 ${n} 的前文。</p><p id="repeat">${repeatedText}</p><p id="after">章节 ${n} 的后文。</p></body></html>`)])),
  });
}

class EventQueue implements AsyncIterable<RunEvent> {
  private values:RunEvent[]=[];
  private waiting:((value:IteratorResult<RunEvent>)=>void)|undefined;
  private ended=false;
  push(value:RunEvent){if(this.ended) throw new Error('Test stream is closed');if(this.waiting){const resolve=this.waiting;this.waiting=undefined;resolve({value,done:false});}else this.values.push(value);}
  end(){this.ended=true;if(this.waiting){this.waiting({value:undefined,done:true});this.waiting=undefined;}}
  [Symbol.asyncIterator](){return {next:():Promise<IteratorResult<RunEvent>>=>{const value=this.values.shift();if(value)return Promise.resolve({value,done:false});if(this.ended)return Promise.resolve({value:undefined,done:true});return new Promise(resolve=>{this.waiting=resolve;});}};}
}
export type Script = (control:RunControl)=>void;
export interface RunControl {request:StartRun;emit(type:RunEvent['type'],data:Record<string,unknown>):void;end():void;}
export class ControlledAdapter implements ClaudeAdapter {
  starts:StartRun[]=[];
  cancellations:string[]=[];
  controls = new Map<string,RunControl>();
  scripts:Script[]=[];
  async probe(){return {installed:false,version:null,authReported:false,invocationVerified:false,message:'Synthetic adapter: real Claude was not invoked.'};}
  async start(request:StartRun):Promise<RunHandle>{
    this.starts.push(request);
    const queue=new EventQueue();let seq=0;
    const control:RunControl={request,emit:(type,data)=>queue.push({runId:request.runId,bookId:request.bookId,discussionId:request.discussionId,seq:++seq,type,data,createdAt:new Date().toISOString()}),end:()=>queue.end()};
    this.controls.set(request.runId,control);
    control.emit('initialized',{cliSessionId:request.session.mode==='resume'?request.session.cliSessionId:randomUUID(),tools:[]});
    const script=this.scripts.shift();
    if(script)script(control);
    else if(request.purpose==='matching'){control.emit('failed',{code:'SYNTHETIC_NO_NETWORK',message:'合成测试未连接检索服务',sessionReusable:false});control.end();}
    else {control.emit('text_delta',{text:'合成概念解释'});control.emit('completed',{text:'合成概念解释',sessionReusable:true,toolResults:[]});control.end();}
    return {runId:request.runId,events:queue};
  }
  async cancel(runId:string){this.cancellations.push(runId);const control=this.controls.get(runId);if(control){control.emit('cancelled',{text:'已生成的合成片段',sessionReusable:false,forced:false});control.end();}}
  async answerPermission(){throw new Error('Permission interaction is outside this synthetic adapter fixture');}
}

export async function makeHarness(adapter=new ControlledAdapter(),existingDir?:string){
  const dir=existingDir??await mkdtemp(join(tmpdir(),'momentread-independent-system-'));
  const store=createStore(dir);
  const library=createBookLibrary(store,dir);
  const learning=createLearningService(store);
  const matching=createMatchingService(store,library);
  const {app}=createApp({store,library,learning,matching,adapter});
  return {dir,store,library,learning,matching,adapter,app,
    request:(path:string,method='GET',body?:unknown)=>app.request(new Request(`http://localhost${path}`,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})),
    async upload(path:string,bytes:Uint8Array,filename='synthetic.epub'){const form=new FormData();form.set('file',new File([Uint8Array.from(bytes)],filename,{type:'application/epub+zip'}));return app.request(new Request(`http://localhost${path}`,{method:'POST',body:form}));},
    async state(bookId:string):Promise<BookState>{const response=await app.request(`/api/books/${bookId}/state`);if(!response.ok)throw new Error(`state request failed: ${response.status} ${await response.text()}`);return BookStateResponseSchema.parse(await response.json());},
    async dispose(remove=true){store.close();if(remove)await rm(dir,{recursive:true,force:true});},
  };
}
export type Harness=Awaited<ReturnType<typeof makeHarness>>;
export async function importSynthetic(h:Harness,title?:string):Promise<Book>{const response=await h.upload('/api/books',syntheticEpub(title));if(!response.ok)throw new Error(`Synthetic EPUB import failed: ${response.status} ${await response.text()}`);return response.json();}
export function reference(book:Book,chapter=1):TextReference{return {bookId:book.id,fileVersionId:book.fileVersionId,segments:[{spineId:`chapter${chapter}`,chapter:chapter===1?'第一章':'第二章',cfi:`epubcfi(/6/${chapter*2}[chapter${chapter}]!/4/4,/1:0,/1:${repeatedText.length})`,exact:repeatedText,prefix:`章节 ${chapter} 的前文。`,suffix:`章节 ${chapter} 的后文。`}]};}
export async function waitFor<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,label:string,timeout=2500):Promise<T>{const deadline=Date.now()+timeout;let latest:T|undefined;while(Date.now()<deadline){latest=await read();if(accept(latest))return latest;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`${label} timed out; last value=${JSON.stringify(latest)}`);}
export async function terminalRun(h:Harness,id:string):Promise<Run>{return waitFor(async()=>{const res=await h.request(`/api/runs/${id}`);return res.json() as Promise<Run>;},run=>['completed','cancelled','failed','interrupted'].includes(run.status),'run to become terminal');}
export function parseSse(text:string):RunEvent[]{return text.split(/\r?\n\r?\n/).filter(block=>/^data:/m.test(block)).map(block=>JSON.parse(block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')));}
