import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {createStore} from '../../server/storage/index';
import {createBookLibrary} from '../../server/books/index';
import {createMatchingService} from '../../server/matching/index';
import {AppError,now,type Discussion} from '../../shared/contracts/index';
import type {Store} from '../../shared/contracts/ports';

const stores:Store[]=[];const dirs:string[]=[];
const epub=(title='Synthetic translation',text='Synthetic reading paragraph.',language='zh')=>zipSync({mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),'EPUB/package.opf':strToU8(`<package><metadata><title>${title}</title><language>${language}</language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`),'EPUB/one.xhtml':strToU8(`<html lang="${language}"><head><title>${title}</title></head><body><p>${text}</p></body></html>`)});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'momentread-matching-'));dirs.push(dir);const store=createStore(dir);stores.push(store);const library=createBookLibrary(store,dir);const book=await library.importBook(epub(),'fixture.epub');const id=randomUUID();const discussion:Discussion={id,bookId:book.id,parentId:null,rootId:id,title:'Synthetic discussion',source:{bookId:book.id,fileVersionId:book.fileVersionId,segments:[{spineId:'one',chapter:'Chapter 1',cfi:'epubcfi(/6/2!/4/2)',exact:'Synthetic reading paragraph.',prefix:'',suffix:''}]},origin:null,draft:'',scrollTop:0,revision:0,needsMerge:false,createdAt:now()};store.put('discussions',discussion);return{store,library,book,discussion};}
const candidate=(quote:string,language='en',url='https://texts.example.org/chapter')=>({url,title:'Public original fixture',language,version:'Different edition, unverified',quote,locator:'Chapter 1',reason:'Candidate found by model, not independently verified'});
afterEach(async()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe('original source verification and history',()=>{
  it.each([['de','Alle Erkenntnis beginnt mit Erfahrung.'],['en','Our knowledge begins with experience.'],['la','Ego sum, ego existo.']])('verifies exact %s text but does not certify the edition',async(language,quote)=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library,{fetchDocument:async url=>({url,text:`Before. ${quote} After.`,contentType:'text/plain'})});
    const [source]=await service.complete(discussion.id,{candidates:[candidate(quote,language)]});
    expect(source).toMatchObject({retrieval:'retrieved',verification:'unverified',selected:false,quote,language});expect(source.evidenceHash).toHaveLength(64);
    expect(service.updateSource(source.id,{selected:true})).toMatchObject({selected:true,verification:'unverified'});
    expect(service.updateSource(source.id,{verification:'confirmed'}).verification).toBe('confirmed');
    expect(store.get('discussions',discussion.id)?.needsMerge).toBe(true);
  });
  it('rejects model paraphrases, other editions, script-only quotes, and case changes',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library,{fetchDocument:async url=>({url,text:'Our cognition commences with experience.',contentType:'text/plain'})});
    const [source]=await service.complete(discussion.id,{candidates:[candidate('Our knowledge begins with experience.')]});
    expect(source).toMatchObject({retrieval:'unavailable',verification:'conflict',quote:'',evidenceHash:''});
    expect(()=>service.updateSource(source.id,{selected:true})).toThrow('尚未取得');
    expect(()=>service.updateSource(source.id,{verification:'confirmed'})).toThrow('尚未取得');
  });
  it('records explicit no-result state without claiming the original does not exist',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library);const values=await service.complete(discussion.id,'{"candidates":[]}');
    expect(values).toHaveLength(1);expect(values[0]).toMatchObject({retrieval:'unavailable',quote:'',url:''});expect(values[0].reason).toContain('不代表原著不存在');
  });
  it('records retrieval failures separately and never stores the alleged quote',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library,{fetchDocument:async()=>{throw new AppError('SOURCE_HTTP_FAILED','原著来源返回 HTTP 403，未取得正文。');}});
    const [source]=await service.complete(discussion.id,{candidates:[candidate('Alleged original text.')]});
    expect(source).toMatchObject({retrieval:'fetch_failed',quote:'',evidenceHash:'',verification:'unverified'});expect(source.reason).toContain('403');
  });
  it('does not mark failed search tools as successful no-result',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library);
    await expect(service.complete(discussion.id,{result:{candidates:[]},toolResults:[{toolName:'WebSearch',success:false,errorCode:'HTTP_403'}]})).rejects.toMatchObject({code:'MATCHING_TOOLS_UNAVAILABLE'});
    expect(store.list('sources')[0]).toMatchObject({retrieval:'fetch_failed',quote:''});
  });
  it('accepts runtime result envelopes while independently verifying candidates',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library,{fetchDocument:async url=>({url,text:'Actual retrieved text.',contentType:'text/plain'})});
    const values=await service.complete(discussion.id,{result:{candidates:[candidate('Actual retrieved text.')]},toolResults:[{toolName:'WebSearch',success:true}]});
    expect(values[0].retrieval).toBe('retrieved');
  });
  it('requires strict JSON and caps candidate input',async()=>{
    const {store,library,discussion}=await fixture();const fetchDocument=vi.fn();const service=createMatchingService(store,library,{fetchDocument});
    for(const invalid of ['```json\n{"candidates":[]}\n```',{candidates:[],claim:'verified'},{candidates:[{...candidate('word'),confirmed:true}]},{candidates:Array(9).fill(candidate('word'))},{candidates:[candidate('   ')]}])await expect(service.complete(discussion.id,invalid)).rejects.toMatchObject({code:'MATCHING_RESULT_INVALID'});
    expect(fetchDocument).not.toHaveBeenCalled();expect(store.list('sources')).toEqual([]);
  });
  it('verifies user-provided TXT and EPUB by file version and preserves old evidence',async()=>{
    const {store,library,book,discussion}=await fixture();const service=createMatchingService(store,library);
    const first=await library.importOriginal(book.id,strToU8('Ego sum, ego existo.'),'original.txt');service.originalAdded(book.id,first.id);
    const context=service.buildInput(discussion.id);expect(context.input).toContain(`momentread-original://${first.id}/text`);expect(store.get('contexts',context.id)).toEqual(context);
    const [source]=await service.complete(discussion.id,{candidates:[candidate('Ego sum, ego existo.','la',`momentread-original://${first.id}/text`)]});
    service.updateSource(source.id,{selected:true,verification:'confirmed'});
    const second=await library.importOriginal(book.id,epub('Latin second version','Ego sum, ego existo. Revised context.','la'),'original.epub');service.originalAdded(book.id,second.id);
    expect(store.get('sources',source.id)).toMatchObject({verification:'conflict',quote:source.quote,evidenceHash:source.evidenceHash});expect(store.get('discussions',discussion.id)?.needsMerge).toBe(true);
    const [newSource]=await service.complete(discussion.id,{candidates:[candidate('Ego sum, ego existo.','la',`momentread-original://${second.id}/${encodeURIComponent('EPUB/one.xhtml')}`)]});
    expect(newSource).toMatchObject({retrieval:'retrieved',fileVersionId:second.id,verification:'unverified'});expect(store.list('sources')).toHaveLength(2);
  });
  it('does not read a local file outside the current book',async()=>{
    const first=await fixture();const second=await fixture();const file=await second.library.importOriginal(second.book.id,strToU8('Private other book text.'),'original.txt');
    const service=createMatchingService(first.store,first.library);const [source]=await service.complete(first.discussion.id,{candidates:[candidate('Private other book text.','en',`momentread-original://${file.id}/text`)]});
    expect(source).toMatchObject({retrieval:'fetch_failed',quote:''});expect(()=>service.originalAdded(first.book.id,file.id)).toThrow('属于当前书籍');
  });
  it('sends bounded original windows and necessary selected text only',async()=>{
    const {store,library,book,discussion}=await fixture();const service=createMatchingService(store,library);await library.importOriginal(book.id,strToU8(`Synthetic reading paragraph. ${'x'.repeat(20000)} NEVER_SEND_THIS_TAIL`),'original.txt');
    const context=service.buildInput(discussion.id);expect(context.input).not.toContain('NEVER_SEND_THIS_TAIL');expect(context.input.length).toBeLessThan(15000);expect(context.messageIds).toEqual([]);
  });
  it('caps the sum of many selected segments and explicitly records truncation',async()=>{
    const {store,library,discussion}=await fixture();const source=discussion.source!;store.put('discussions',{...discussion,source:{...source,segments:Array.from({length:20},(_,i)=>({...source.segments[0],exact:String(i).repeat(2000)}))}});
    const context=createMatchingService(store,library).buildInput(discussion.id);expect(context.input.length).toBeLessThan(12000);expect(context.input).toContain('"selectionTruncated":true');
  });
  it('deduplicates identical candidates in a run while preserving separate run history',async()=>{
    const {store,library,discussion}=await fixture();const service=createMatchingService(store,library,{fetchDocument:async url=>({url,text:'A verifiable sentence.',contentType:'text/plain'})});const input={candidates:[candidate('A verifiable sentence.'),candidate('A verifiable sentence.')]};
    expect(await service.complete(discussion.id,input)).toHaveLength(1);expect(await service.complete(discussion.id,input)).toHaveLength(1);expect(store.list('sources')).toHaveLength(2);
  });
});
