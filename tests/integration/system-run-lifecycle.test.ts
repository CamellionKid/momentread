import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ControlledAdapter, importSynthetic, makeHarness, reference, terminalRun, waitFor, type Harness} from '../contract/system-fixtures';
import type {RetrievedDocument} from '../../server/matching/network';

const opened:Harness[]=[];
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
const candidate={url:'https://example.org/chapter',title:'Synthetic original',language:'en',version:'Unverified',quote:'Synthetic original text.',locator:'Chapter 1',reason:''};
class PermissionAdapter extends ControlledAdapter {
  async answerPermission(runId:string,requestId:string,decision:'allowRun'|'denyRun') {
    this.controls.get(runId)!.emit('permission_resolved',{requestId,decision});
  }
}
async function setup(fetchDocument=vi.fn(async(url:string,_signal?:AbortSignal):Promise<RetrievedDocument>=>({url,text:candidate.quote,contentType:'text/plain'}))) {
  const h=await makeHarness(new PermissionAdapter(),undefined,'claude',undefined,{fetchDocument});opened.push(h);
  const book=await importSynthetic(h);
  return {h,book,fetchDocument};
}
async function start(h:Harness,book:Awaited<ReturnType<typeof importSynthetic>>,permission=true) {
  const requestId=randomUUID();
  h.adapter.scripts.push(control=>{if(permission)control.emit('permission_required',{requestId,toolName:'WebFetch'});});
  const response=await h.request('/api/analyses','POST',{source:reference(book)});
  expect(response.status).toBe(202);
  const {runId}=await response.json();
  await waitFor(async()=>h.store.get('runs',runId),run=>run?.status===(permission?'permission':'running'),'run ready');
  return {runId,requestId};
}
function complete(h:Harness,runId:string,toolResults:unknown[]=[]) {
  const control=h.adapter.controls.get(runId)!;
  control.emit('completed',{structuredOutput:{candidates:[candidate]},toolResults});control.end();
}

describe('run-wide network consent and cancellation',()=>{
  it.each(['denyRun','unset'] as const)('never retrieves a public candidate with %s consent, even if the model claims success',async decision=>{
    const {h,book,fetchDocument}=await setup();const {runId,requestId}=await start(h,book,decision!=='unset');
    if(decision==='denyRun')expect((await h.request(`/api/runs/${runId}/permission`,'POST',{requestId,decision})).status).toBe(200);
    complete(h,runId,[{toolName:'WebFetch',success:decision==='unset',errorCode:'PERMISSION_DENIED'}]);
    await terminalRun(h,runId);
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(h.store.list('sources').every(source=>source.retrieval!=='retrieved'&&!source.quote)).toBe(true);
  });
  it('requires a live permission request and passes explicit consent to both adapter and retrieval',async()=>{
    const {h,book,fetchDocument}=await setup();const {runId,requestId}=await start(h,book);
    expect((await h.request(`/api/runs/${runId}/permission`,'POST',{requestId:randomUUID(),decision:'allowRun'})).status).toBe(409);
    expect((await h.request(`/api/runs/${runId}/permission`,'POST',{requestId,decision:'allowRun'})).status).toBe(200);
    expect(h.adapter.starts[0].lifecycle?.networkDecision).toBe('allowRun');
    complete(h,runId);expect((await terminalRun(h,runId)).status).toBe('completed');
    expect(fetchDocument).toHaveBeenCalledTimes(1);expect(h.store.list('sources')[0].retrieval).toBe('retrieved');
  });
  it('does not reuse network consent in a later matching run',async()=>{
    const {h,book,fetchDocument}=await setup();const first=await start(h,book);
    await h.request(`/api/runs/${first.runId}/permission`,'POST',{requestId:first.requestId,decision:'allowRun'});
    complete(h,first.runId);await terminalRun(h,first.runId);
    const second=await start(h,book,false);complete(h,second.runId);await terminalRun(h,second.runId);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel','shutdown'] as const)('%s stops postprocessing after CLI exit, discards late sources and prevents automatic continuation',async action=>{
    let release!:(document:RetrievedDocument)=>void;
    const fetchDocument=vi.fn((_url:string,_signal?:AbortSignal)=>new Promise<RetrievedDocument>(resolve=>{release=resolve;}));
    const {h,book}=await setup(fetchDocument);const {runId,requestId}=await start(h,book);
    await h.request(`/api/runs/${runId}/permission`,'POST',{requestId,decision:'allowRun'});
    let settled=false;const original=h.matching.complete.bind(h.matching);
    vi.spyOn(h.matching,'complete').mockImplementation((...args)=>original(...args).finally(()=>{settled=true;}));
    complete(h,runId);await waitFor(async()=>fetchDocument.mock.calls.length,Boolean,'server retrieval started');
    try {
      if(action==='shutdown')await h.runs.shutdown();else expect((await h.request(`/api/runs/${runId}/cancel`,'POST')).status).toBe(200);
      expect(fetchDocument.mock.calls[0][1]?.aborted).toBe(true);
      expect(h.store.get('runs',runId)?.status).toBe('cancelled');
    } finally {
      release({url:candidate.url,text:candidate.quote,contentType:'text/plain'});
      await waitFor(async()=>settled,Boolean,'late postprocessing settled');
    }
    expect(h.store.get('runs',runId)).toMatchObject({status:'cancelled',sessionReusable:false,result:null});
    expect(h.store.list('sources')).toEqual([]);expect(h.adapter.starts).toHaveLength(1);
    expect(h.store.events(runId).filter(event=>['completed','cancelled','failed'].includes(event.type)).map(event=>event.type)).toEqual(['cancelled']);
  });
  it('keeps a committed completion when cancellation arrives after success',async()=>{
    const {h,book}=await setup();const {runId,requestId}=await start(h,book);
    await h.request(`/api/runs/${runId}/permission`,'POST',{requestId,decision:'allowRun'});
    complete(h,runId);await terminalRun(h,runId);
    await h.request(`/api/runs/${runId}/cancel`,'POST');
    expect(h.store.get('runs',runId)?.status).toBe('completed');
    expect(h.store.events(runId).filter(event=>['completed','cancelled'].includes(event.type)).map(event=>event.type)).toEqual(['completed']);
  });
  it('cancellation wins when completion is queued in the same turn',async()=>{
    const {h,book,fetchDocument}=await setup();const {runId,requestId}=await start(h,book);
    await h.request(`/api/runs/${runId}/permission`,'POST',{requestId,decision:'allowRun'});
    complete(h,runId);await h.runs.cancel(runId);
    expect((await terminalRun(h,runId)).status).toBe('cancelled');
    expect(fetchDocument).not.toHaveBeenCalled();expect(h.adapter.starts).toHaveLength(1);
  });
});
