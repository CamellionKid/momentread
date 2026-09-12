import {randomUUID} from 'node:crypto';
import {AppError,now,type ContextSnapshot,type Run,type RunEvent,type RunPurpose} from '../shared/contracts/index';
import type {ClaudeAdapter,Store} from '../shared/contracts/ports';

type Hooks={reportTarget?:{date:string;timezone:string};onComplete?:(event:RunEvent,run:Run)=>Promise<void>|void;result?:(event:RunEvent,run:Run)=>unknown;onTerminal?:(run:Run)=>Promise<void>|void};
export type RuntimeResolver=()=>{adapter:ClaudeAdapter;provider:'claude'|'opencode'};
type Pinned={adapter:ClaudeAdapter;provider:'claude'|'opencode';model:string|undefined};
export class RunManager {
 private active=new Map<string,{discussionId:string;purpose:RunPurpose;pinned:Pinned}>();
 constructor(private store:Store,private resolve:RuntimeResolver){
  store.transaction(()=>{for(const run of store.list('runs'))if(['queued','running','permission'].includes(run.status)){
   store.put('runs',{...run,status:'interrupted',sessionReusable:false,error:'服务已重启；这次运行中断，可保留内容后重新发起。',updatedAt:now()});
   for(const session of store.list('sessions',run.bookId).filter(s=>s.discussionId===run.discussionId))store.put('sessions',{...session,reusable:false});
  }});
  for(const m of store.list('messages'))if(m.status==='streaming')store.put('messages',{...m,status:'interrupted'});
 }
 busy(discussionId:string){return [...this.active.values()].some(r=>r.discussionId===discussionId)}
 private reusableSession(context:ContextSnapshot,provider:'claude'|'opencode'){
  // A session may be resumed only by its owning runtime and only when no
  // completed exchange happened elsewhere since (at most the triggering user
  // message is new). Legacy rows without runtime/coverage never qualify.
  const messages=this.store.list('messages',context.bookId).filter(m=>m.discussionId===context.discussionId).length;
  return this.store.list('sessions',context.bookId)
   .filter(s=>s.discussionId===context.discussionId&&s.reusable&&s.runtime===provider&&s.coverage!==undefined&&s.coverage+1>=messages)
   .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
 }
 async start(context:ContextSnapshot,purpose:RunPurpose,hooks:Hooks={},outputSchema?:Record<string,unknown>):Promise<Run>{
  if(this.busy(context.discussionId))throw new AppError('RUN_BUSY','当前讨论仍有运行，请等待或停止后重试。',409,true);
  if(this.active.size>=3)throw new AppError('RUNTIME_BUSY','当前任务较多，请稍后重试。',429,true);
  const {adapter,provider}=this.resolve();
  const pinned:Pinned={adapter,provider,model:this.store.getIdempotent(`ai.model.${provider}`) as string|undefined};
  const session=purpose==='discussion'?this.reusableSession(context,provider):undefined;
  const run:Run={id:randomUUID(),bookId:context.bookId,discussionId:context.discussionId,purpose,...(hooks.reportTarget?{reportTarget:hooks.reportTarget}:{}),status:'queued',contextSnapshotId:context.id,sessionId:session?.cliSessionId??null,sessionReusable:false,partialText:'',result:null,error:null,createdAt:now(),updatedAt:now()};
  this.store.put('runs',run);this.active.set(run.id,{discussionId:run.discussionId,purpose,pinned});
  void this.consume(run,context,hooks,outputSchema,pinned,session?.cliSessionId);
  return run;
 }
 private async consume(run:Run,context:ContextSnapshot,hooks:Hooks,outputSchema:Record<string,unknown>|undefined,pinned:Pinned,sessionId?:string){
  let seq=0;let terminal=false;
  const record=async(e:RunEvent)=>{
   if(terminal)return;
   e={...e,runId:run.id,bookId:run.bookId,discussionId:run.discussionId,seq:++seq,createdAt:now()};
   const current=this.store.get('runs',run.id)!;
   let next={...current,updatedAt:now()};
   if(e.type==='initialized'){next.status='running';next.sessionId=typeof e.data.cliSessionId==='string'?e.data.cliSessionId:next.sessionId;}
   if(e.type==='text_delta'){next.status='running';next.partialText+=String(e.data.text??'');}
   if(e.type==='permission_required')next.status='permission';
   if(e.type==='permission_resolved')next.status='running';
   if(e.type==='completed'){
    next.status='completed';next.result=e.data.structuredOutput??e.data.text??next.partialText;next.partialText=typeof e.data.text==='string'?e.data.text:next.partialText;next.sessionReusable=e.data.sessionReusable===true;
    // Persist domain results before advertising completion; validation errors become failed runs.
    await hooks.onComplete?.(e,next);
    if(hooks.result)next.result=hooks.result(e,next);
   }
   if(e.type==='failed'||e.type==='cancelled'){next.status=e.type;next.error=String(e.data.message??(e.type==='cancelled'?'已停止生成':'生成失败'));next.sessionReusable=false;}
   this.store.transaction(()=>{this.store.put('runs',next);this.store.appendEvent(e);
    if(['completed','failed','cancelled'].includes(next.status)&&next.sessionId){
     for(const s of this.store.list('sessions',run.bookId).filter(s=>s.discussionId===run.discussionId&&s.cliSessionId===next.sessionId))this.store.put('sessions',{...s,reusable:next.sessionReusable});
     if(next.status==='completed'&&run.purpose==='discussion'&&next.sessionReusable)this.store.put('sessions',{id:randomUUID(),bookId:run.bookId,discussionId:run.discussionId,cliSessionId:next.sessionId,runtime:pinned.provider,coverage:this.store.list('messages',run.bookId).filter(m=>m.discussionId===run.discussionId).length,reusable:true,createdAt:now()});
    }
   });
   if(['completed','failed','cancelled'].includes(next.status)){terminal=true;this.active.delete(run.id);await hooks.onTerminal?.(next);}
  };
  try{
   const handle=await pinned.adapter.start({runId:run.id,bookId:run.bookId,discussionId:run.discussionId,purpose:run.purpose,contextSnapshotId:context.id,input:context.input,session:sessionId?{mode:'resume',cliSessionId:sessionId}:{mode:'new'},outputSchema,model:pinned.model});
   for await(const event of handle.events)await record(event);
   if(!terminal)throw new AppError('INCOMPLETE_RUN','运行结束但缺少完整结果。',502,true);
  }catch(error){
   if(!terminal){const e=error instanceof AppError?error:new AppError('RUN_FAILED','运行未完成，请查看连接状态或重试。',502,true);await record({runId:run.id,bookId:run.bookId,discussionId:run.discussionId,seq:0,type:'failed',data:{code:e.code,message:e.message,sessionReusable:false},createdAt:now()});}
  }finally{this.active.delete(run.id)}
 }
 async cancel(runId:string){const run=this.store.get('runs',runId);if(!run)throw new AppError('NOT_FOUND','找不到运行。',404);const entry=this.active.get(runId);if(!entry)return;await entry.pinned.adapter.cancel(runId);}
 async permission(runId:string,requestId:string,decision:'allowRun'|'denyRun'){const entry=this.active.get(runId);if(!entry)throw new AppError('PERMISSION_EXPIRED','该权限请求已失效。',409);await entry.pinned.adapter.answerPermission(runId,requestId,decision);}
 activeCount(){return this.active.size}
 async shutdown(){await Promise.allSettled([...this.active.entries()].map(([id,entry])=>entry.pinned.adapter.cancel(id)))}
}
