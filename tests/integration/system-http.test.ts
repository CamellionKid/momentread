import {afterEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {BookSchema, EventSchema, WorkspaceSchema} from '../../shared/contracts';
import {BookListResponseSchema, ConfirmResponseSchema, DailyReportResponseSchema, HealthResponseSchema, HistoryResponseSchema, RuntimeResponseSchema} from '../../shared/contracts/http';
import type {Book, Discussion} from '../../shared/contracts';
import {ControlledAdapter, importSynthetic, makeHarness, parseSse, reference, syntheticEpub, terminalRun, waitFor} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(adapter?:ControlledAdapter,existingDir?:string){const h=await makeHarness(adapter,existingDir);opened.push(h);return h;}
async function closeForRestart(h:Harness){await h.dispose(false);opened.splice(opened.indexOf(h),1);}
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
async function expectClientError(response:Response){const detail=await response.clone().text();expect(response.status,detail).toBeGreaterThanOrEqual(400);expect(response.status,detail).toBeLessThan(500);expect(await response.json()).toEqual({error:{code:expect.any(String),message:expect.any(String),retryable:expect.any(Boolean)},requestId:expect.any(String)});}
async function root(h:Harness,book:Book):Promise<Discussion>{return h.learning.createRoot({source:reference(book),question:'解释这个合成段落'});}
async function answer(h:Harness,discussionId:string){const response=await h.request(`/api/discussions/${discussionId}/messages`,'POST',{text:'请解释合成概念'});expect(response.ok).toBe(true);const {runId}=await response.json();await terminalRun(h,runId);return (await h.state(h.store.get('discussions',discussionId)!.bookId)).messages.find(message=>message.runId===runId)!;}
async function branch(h:Harness,parent:Discussion){const message=await answer(h,parent.id);const exact='合成概念';const start=message.text.indexOf(exact);const response=await h.request('/api/branches','POST',{parentId:parent.id,title:exact,origin:{messageId:message.id,start,end:start+exact.length,exact}});expect(response.ok).toBe(true);const result=await response.json();await terminalRun(h,result.runId);return h.store.get('discussions',result.discussionId)!;}

describe('independent HTTP and system acceptance using synthetic inputs',()=>{
  it('A21: public read endpoints match their response contracts when the AI backend is unavailable',async()=>{
    const h=await harness();const health=await h.request('/api/health');expect(health.ok).toBe(true);HealthResponseSchema.parse(await health.json());
    const runtime=await h.request('/api/runtime');expect(runtime.ok).toBe(true);expect(RuntimeResponseSchema.parse(await runtime.json())).toMatchObject({installed:false,invocationVerified:false});
    const book=await importSynthetic(h);const list=await h.request('/api/books');expect(list.ok).toBe(true);expect(BookListResponseSchema.parse(await list.json()).map(item=>item.id)).toEqual([book.id]);
    expect((await h.state(book.id)).book.id).toBe(book.id);const report=await h.request(`/api/books/${book.id}/report?date=2026-09-10&timezone=UTC`);expect(report.ok).toBe(true);expect(DailyReportResponseSchema.parse(await report.json()).book.id).toBe(book.id);expect(h.adapter.starts).toHaveLength(0);
  });

  it('A01/A11: copies imported EPUB bytes and restores chapter, font, active discussion, and separate drafts after reopening SQLite',async()=>{
    const h=await harness();const original=join(h.dir,'source-original.epub');const bytes=syntheticEpub();await writeFile(original,bytes);
    const imported=await h.upload('/api/books',await readFile(original));expect(imported.status).toBeLessThan(300);const book=BookSchema.parse(await imported.json());
    await rename(original,join(h.dir,'source-moved.epub'));
    expect(new Uint8Array(await (await h.request(`/api/files/${book.fileVersionId}`)).arrayBuffer())).toEqual(bytes);
    const one=await root(h,book);const two=h.learning.createRoot({source:reference(book,2),question:'第二章重复句'});
    await h.request(`/api/discussions/${one.id}`,'PATCH',{draft:'第一章的独立草稿',scrollTop:138});
    await h.request(`/api/discussions/${two.id}`,'PATCH',{draft:'第二章的独立草稿',scrollTop:246});
    const position={fileVersionId:book.fileVersionId,cfi:'epubcfi(/6/4[chapter2]!/4/4/1:6)',progress:0.63,chapter:'第二章'};
    const saved=await h.request(`/api/books/${book.id}/workspace`,'PATCH',{position,activeDiscussionId:two.id,collapsed:[one.id],fontSize:30});expect(saved.ok,await saved.clone().text()).toBe(true);WorkspaceSchema.parse(await saved.json());
    const restartedDir=h.dir;await closeForRestart(h);const reopened=await harness(undefined,restartedDir);const state=await reopened.state(book.id);
    expect(state.workspace).toMatchObject({position,activeDiscussionId:two.id,collapsed:[one.id],fontSize:30});
    expect(state.discussions.find(d=>d.id===one.id)).toMatchObject({draft:'第一章的独立草稿',scrollTop:138,source:reference(book)});
    expect(state.discussions.find(d=>d.id===two.id)).toMatchObject({draft:'第二章的独立草稿',scrollTop:246,source:reference(book,2)});
    expect(new Uint8Array(await (await reopened.request(`/api/files/${book.fileVersionId}`)).arrayBuffer())).toEqual(bytes);
    expect(reopened.adapter.starts).toHaveLength(0);
  });

  it.each([
    ['POST','/api/analyses',{}],
    ['POST','/api/branches',{parentId:'invalid'}],
    ['GET','/api/books/not-an-id/state',undefined],
    ['GET','/api/files/not-an-id',undefined],
    ['GET','/api/runs/not-an-id',undefined],
    ['PATCH','/api/discussions/not-an-id',{draft:'x'}],
    ['POST',`/api/summaries/${randomUUID()}/confirm`,{requestId:'invalid',content:'x'}],
  ])('returns a structured 4xx for invalid or missing IDs: %s %s',async(method,path,body)=>{
    const h=await harness();await expectClientError(await h.request(path as string,method as string,body));expect(h.adapter.starts).toHaveLength(0);
  });

  it('rejects malformed JSON and an invalid EPUB without creating a book',async()=>{
    const h=await harness();await expectClientError(await h.app.request(new Request('http://localhost/api/analyses',{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'})));
    await expectClientError(await h.upload('/api/books',new TextEncoder().encode('not a ZIP')));expect(await (await h.request('/api/books')).json()).toEqual([]);
  });

  it('rejects wrong-book file versions, active discussion, collapsed IDs and positions with no partial workspace mutation',async()=>{
    const h=await harness();const a=await importSynthetic(h,'甲书');const b=await importSynthetic(h,'乙书');const other=await root(h,b);const before=(await h.state(a.id)).workspace;
    for(const body of [{activeDiscussionId:other.id},{collapsed:[other.id]},{fontSize:30,position:{fileVersionId:b.fileVersionId,cfi:'epubcfi(/6/2!/4/2/1:0)',progress:0.2,chapter:'错书'}}]){
      await expectClientError(await h.request(`/api/books/${a.id}/workspace`,'PATCH',body));expect((await h.state(a.id)).workspace).toEqual(before);
    }
    await expectClientError(await h.request('/api/analyses','POST',{source:{...reference(a),fileVersionId:b.fileVersionId}}));expect(h.adapter.starts).toHaveLength(0);expect((await h.state(a.id)).discussions).toEqual([]);
  });

  it('rejects a branch origin from another book or mismatched text and leaves both trees intact',async()=>{
    const h=await harness();const a=await importSynthetic(h,'甲书');const b=await importSynthetic(h,'乙书');const parent=await root(h,a);const other=await root(h,b);const foreign=await answer(h,other.id);
    const before=(await h.state(a.id)).discussions;
    await expectClientError(await h.request('/api/branches','POST',{parentId:parent.id,title:'概念',origin:{messageId:foreign.id,start:0,end:4,exact:foreign.text.slice(0,4)}}));
    const own=await answer(h,parent.id);
    await expectClientError(await h.request('/api/branches','POST',{parentId:parent.id,title:'概念',origin:{messageId:own.id,start:0,end:4,exact:'不一致的文本'}}));
    expect((await h.state(a.id)).discussions.map(d=>d.id)).toEqual(before.map(d=>d.id));
  });

  it('A06/A11/A16: confirms edited text once, returns only to the direct parent, and preserves idempotency through restart',async()=>{
    const h=await harness();const book=await importSynthetic(h);const main=await root(h,book);const child=await branch(h,main);const grandchild=await branch(h,child);
    await h.request(`/api/discussions/${child.id}`,'PATCH',{scrollTop:432});
    const context=h.learning.buildInput(grandchild.id,'summary');const draft=h.learning.createSummaryDraft(context.id,'模型的合成小结');const request={requestId:randomUUID(),content:'用户修订：仍有一个问题待核。'};
    const first=await h.request(`/api/summaries/${draft.id}/confirm`,'POST',request);expect(first.ok).toBe(true);const confirmed=await first.json();expect(confirmed).toMatchObject({parentId:child.id,summary:{content:request.content,confirmed:true,version:1}});
    const state=await h.state(book.id);expect(state.receipts).toHaveLength(1);expect(state.receipts[0]).toMatchObject({parentId:child.id,childId:grandchild.id,summaryId:draft.id});expect(state.discussions.find(d=>d.id===child.id)?.scrollTop).toBe(432);
    const directory=h.dir;await closeForRestart(h);const reopened=await harness(undefined,directory);const repeated=await reopened.request(`/api/summaries/${draft.id}/confirm`,'POST',request);expect(repeated.ok).toBe(true);expect(await repeated.json()).toEqual(confirmed);expect((await reopened.state(book.id)).receipts).toHaveLength(1);
    await expectClientError(await reopened.request(`/api/summaries/${draft.id}/confirm`,'POST',{...request,content:'同一请求 ID 换了正文'}));
    expect((await reopened.state(book.id)).summaries.find(s=>s.id===draft.id)?.content).toBe(request.content);
  });

  it('A07: rejects a stale summary preview and keeps its unconfirmed text and discussion',async()=>{
    const h=await harness();const book=await importSynthetic(h);const discussion=await root(h,book);const context=h.learning.buildInput(discussion.id,'summary');const draft=h.learning.createSummaryDraft(context.id,'原始待确认小结');
    await answer(h,discussion.id);
    await expectClientError(await h.request(`/api/summaries/${draft.id}/confirm`,'POST',{requestId:randomUUID(),content:'过期编辑'}));
    const state=await h.state(book.id);expect(state.summaries.find(s=>s.id===draft.id)).toMatchObject({confirmed:false,content:'原始待确认小结'});expect(state.messages.length).toBeGreaterThan(1);expect(state.receipts).toEqual([]);
  });

  it('A06/A07: a valid structured summary is only a preview until edited confirmation and is exposed through history',async()=>{
    const adapter=new ControlledAdapter();adapter.scripts.push(control=>{control.emit('completed',{text:'这不是要保存的结构化正文',structuredOutput:{content:'待用户核对的合成小结'},sessionReusable:true,toolResults:[]});control.end();});
    const h=await harness(adapter);const book=await importSynthetic(h);const discussion=await root(h,book);const started=await h.request(`/api/discussions/${discussion.id}/summary`,'POST');expect(started.ok).toBe(true);const {runId}=await started.json();expect((await terminalRun(h,runId)).status).toBe('completed');
    const before=await h.state(book.id);expect(before.summaries).toEqual([expect.objectContaining({content:'待用户核对的合成小结',confirmed:false,version:0})]);expect(before.receipts).toEqual([]);expect(before.messages.some(message=>message.runId===runId)).toBe(false);
    const confirmed=await h.request(`/api/summaries/${before.summaries[0].id}/confirm`,'POST',{requestId:randomUUID(),content:'用户已修订的合成结论'});expect(confirmed.ok).toBe(true);expect(ConfirmResponseSchema.parse(await confirmed.json())).toMatchObject({parentId:null,summary:{content:'用户已修订的合成结论',confirmed:true}});
    const history=await h.request(`/api/discussions/${discussion.id}/history`);expect(history.ok).toBe(true);expect(HistoryResponseSchema.parse(await history.json())).toEqual([expect.objectContaining({content:'用户已修订的合成结论',confirmed:true,version:1})]);
  });

  it('A12: exports offline HTML with literal hostile text but no executable markup',async()=>{
    const h=await harness();const hostile='<script>globalThis.systemTestXss=1</script><img src=x onerror="alert(1)">&';const book=await importSynthetic(h,hostile);const discussion=await root(h,book);const draft=h.learning.createSummaryDraft(h.learning.buildInput(discussion.id,'summary').id,hostile);h.learning.confirmSummary(draft.id,{requestId:randomUUID(),content:hostile});
    const response=await h.request(`/api/books/${book.id}/report.html?date=${new Date().toISOString().slice(0,10)}&timezone=UTC`);expect(response.ok).toBe(true);expect(response.headers.get('content-type')).toContain('text/html');
    const document=new JSDOM(await response.text()).window.document;expect(document.querySelectorAll('script,img,[onerror]')).toHaveLength(0);expect(document.body.textContent).toContain(hostile);expect(document.querySelectorAll('script[src],link[href^="http"]')).toHaveLength(0);
  });

  it('backs up real files and learning data, restores into empty storage, and rejects overwrite of a populated library',async()=>{
    const source=await harness();const book=await importSynthetic(source);const discussion=await root(source,book);await source.request(`/api/discussions/${discussion.id}`,'PATCH',{draft:'备份中的草稿',scrollTop:87});
    const created=await source.request('/api/backups','POST');expect(created.ok).toBe(true);const {id}=await created.json();const download=await source.request(`/api/backups/${id}`);expect(download.ok).toBe(true);const backup=new Uint8Array(await download.arrayBuffer());
    const empty=await harness();const restored=await empty.upload('/api/restore',backup,'backup.zip');expect(restored.ok).toBe(true);expect(await restored.json()).toEqual({ok:true});expect((await empty.state(book.id)).discussions.find(d=>d.id===discussion.id)).toMatchObject({draft:'备份中的草稿',scrollTop:87});
    const restoredBytes=new Uint8Array(await (await empty.request(`/api/files/${book.fileVersionId}`)).arrayBuffer());
    const sourceBytes=new Uint8Array(await (await source.request(`/api/files/${book.fileVersionId}`)).arrayBuffer());
    expect(restoredBytes).toEqual(sourceBytes);
    const populated=await harness();const own=await importSynthetic(populated,'已有书');await expectClientError(await populated.upload('/api/restore',backup,'backup.zip'));expect((await (await populated.request('/api/books')).json()).map((item:Book)=>item.id)).toEqual([own.id]);
  });

  it('A02/A08/A21: failed matching still produces one explicitly unverified discussion run, and reopening does not trigger AI',async()=>{
    const h=await harness();const book=await importSynthetic(h);const response=await h.request('/api/analyses','POST',{source:reference(book),question:'请分析合成段落'});expect(response.ok,await response.clone().text()).toBe(true);const result=await response.json();
    const state=await waitFor(()=>h.state(book.id),state=>state.runs.length===2&&state.runs.every(run=>['completed','failed'].includes(run.status)),'matching then analysis');
    expect(state.discussions).toHaveLength(1);expect(state.discussions[0]).toMatchObject({id:result.discussionId,source:reference(book)});expect(h.adapter.starts.map(run=>run.purpose)).toEqual(['matching','discussion']);expect(state.sources.every(source=>source.verification!=='confirmed')).toBe(true);
    expect(h.adapter.starts[1].input).toMatch(/未|unverified|核对|对照/);await h.request(`/api/books/${book.id}/state`);await h.request(`/api/books/${book.id}/state`);expect(h.adapter.starts).toHaveLength(2);
  });

  it('SSE replays only later events after a cursor without restarting the AI',async()=>{
    const h=await harness();const book=await importSynthetic(h);const discussion=await root(h,book);const response=await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'流式测试'});const {runId}=await response.json();await terminalRun(h,runId);
    const first=await h.request(`/api/runs/${runId}/events`);expect(first.headers.get('content-type')).toContain('text/event-stream');const events=parseSse(await first.text());expect(events.length).toBeGreaterThan(1);events.forEach(event=>{EventSchema.parse(event);expect(event).toMatchObject({runId,bookId:book.id,discussionId:discussion.id});});
    const cursor=events[0].seq;const query=parseSse(await (await h.request(`/api/runs/${runId}/events?after=${cursor}`)).text());
    const header=parseSse(await (await h.app.request(new Request(`http://localhost/api/runs/${runId}/events`,{headers:{'Last-Event-ID':String(cursor)}}))).text());
    expect(query).toEqual(events.filter(event=>event.seq>cursor));expect(header).toEqual(query);expect(new Set(events.map(event=>event.seq)).size).toBe(events.length);expect(h.adapter.starts).toHaveLength(1);
  });

  it('routes delayed output to its original discussion after active-node changes',async()=>{
    const adapter=new ControlledAdapter();adapter.scripts.push(()=>{});const h=await harness(adapter);const book=await importSynthetic(h);const original=await root(h,book);const elsewhere=await root(h,book);
    const response=await h.request(`/api/discussions/${original.id}/messages`,'POST',{text:'只属于原节点的问题'});const {runId}=await response.json();await waitFor(async()=>adapter.controls.has(runId),Boolean,'adapter start');
    await h.request(`/api/books/${book.id}/workspace`,'PATCH',{activeDiscussionId:elsewhere.id});const control=adapter.controls.get(runId)!;control.emit('text_delta',{text:'只属于原节点的回复'});control.emit('completed',{text:'只属于原节点的回复',sessionReusable:true,toolResults:[]});control.end();await terminalRun(h,runId);
    const state=await h.state(book.id);expect(state.workspace.activeDiscussionId).toBe(elsewhere.id);expect(state.messages.filter(m=>m.runId===runId)).toEqual([expect.objectContaining({discussionId:original.id,bookId:book.id,text:'只属于原节点的回复'})]);expect(state.messages.filter(m=>m.discussionId===elsewhere.id&&m.role==='assistant')).toEqual([]);
  });

  it('rejects a concurrent run without silently saving the rejected question; cancellation preserves partial text and disables session reuse',async()=>{
    const adapter=new ControlledAdapter();adapter.scripts.push(control=>control.emit('text_delta',{text:'已生成的合成片段'}));const h=await harness(adapter);const book=await importSynthetic(h);const discussion=await root(h,book);
    const first=await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'允许的问题'});const {runId}=await first.json();await waitFor(async()=>adapter.controls.has(runId),Boolean,'running control');
    await expectClientError(await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'并发被拒绝的问题'}));expect(adapter.starts).toHaveLength(1);expect((await h.state(book.id)).messages.some(message=>message.text==='并发被拒绝的问题')).toBe(false);
    const cancelled=await h.request(`/api/runs/${runId}/cancel`,'POST');expect(cancelled.ok).toBe(true);expect(await cancelled.json()).toEqual({ok:true});const final=await terminalRun(h,runId);expect(final).toMatchObject({status:'cancelled',sessionReusable:false});expect(adapter.cancellations).toEqual([runId]);
    expect((await h.state(book.id)).messages.find(message=>message.runId===runId)).toMatchObject({discussionId:discussion.id,text:'已生成的合成片段',status:'interrupted'});
    await answer(h,discussion.id);expect(adapter.starts[1].session).toEqual({mode:'new'});
  });

  it('marks a stream that ends without a final result as failed and keeps partial discussion text',async()=>{
    const adapter=new ControlledAdapter();adapter.scripts.push(control=>{control.emit('text_delta',{text:'缺最终事件的合成片段'});control.end();});const h=await harness(adapter);const book=await importSynthetic(h);const discussion=await root(h,book);
    const response=await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'模拟中断'});const {runId}=await response.json();const run=await terminalRun(h,runId);expect(run.status).toBe('failed');expect(run.sessionReusable).toBe(false);expect(run.error).toBeTruthy();expect((await h.state(book.id)).messages.find(message=>message.runId===runId)).toMatchObject({text:'缺最终事件的合成片段',status:'failed'});
  });

  it('A07: rejects a summary result that violates the requested output schema and does not create a completed summary',async()=>{
    const adapter=new ControlledAdapter();adapter.scripts.push(control=>{control.emit('completed',{text:'malformed summary',structuredOutput:{unexpected:'wrong shape'},sessionReusable:true,toolResults:[]});control.end();});const h=await harness(adapter);const book=await importSynthetic(h);const discussion=await root(h,book);
    const response=await h.request(`/api/discussions/${discussion.id}/summary`,'POST');expect(response.ok).toBe(true);const {runId}=await response.json();const run=await terminalRun(h,runId);expect(run.status).toBe('failed');expect(run.error).toBeTruthy();expect((await h.state(book.id)).summaries).toEqual([]);expect((await h.state(book.id)).discussions).toHaveLength(1);
  });
});
