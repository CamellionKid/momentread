import {BookMetadataPatchSchema,WorkspacePatchSchema,DiscussionPatchSchema,MessageRequestSchema,SourcePatchSchema,PermissionRequestSchema,SummaryOutputSchema} from '../shared/contracts/http';
import {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {AnalysisRequestSchema,BranchRequestSchema,ConfirmRequestSchema,PositionSchema,Id,AppError,now,type BookState,type Run,type RunEvent} from '../shared/contracts/index';
import type {Store,BookLibrary,ClaudeAdapter,LearningService,MatchingService} from '../shared/contracts/ports';
import {RunManager} from './runs';
import {buildReport,renderReport,dayAt} from './exports/index';

type Services={store:Store;library:BookLibrary;adapter:ClaudeAdapter;learning:LearningService;matching:MatchingService;port?:number;ai?:{provider:'claude'|'opencode';model?:string}};
export function createApp(services:Services){
 const {store,library,adapter,learning,matching}=services;const runs=new RunManager(store,adapter);const app=new Hono();
 const matchingUnsupported=()=>new AppError('MATCHING_UNSUPPORTED','当前 AI 运行时不支持原著检索，请切换为 Claude Code 后重试。',400);
 const supportsMatching=()=>services.ai?.provider!=='opencode';
 // Download capabilities belong to this service instance, never to restored data.
 const backupDownloads=new Map<string,string>();
 const required=<T>(value:T|undefined,message='找不到记录。'):T=>{if(value===undefined)throw new AppError('NOT_FOUND',message,404);return value};
 const book=(id:string)=>required(store.get('books',Id.parse(id)),'找不到书籍。');
 const workspace=(id:string)=>{book(id);let w=store.get('workspaces',id);if(!w){const legacy=store.list('workspaces',id).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];w=legacy?{...legacy,id,bookId:id}:{id,bookId:id,position:null,activeDiscussionId:null,collapsed:[],fontSize:24,flow:'scrolled',updatedAt:now()};store.put('workspaces',w)}return w};
 const discussion=(id:string)=>required(store.get('discussions',Id.parse(id)),'找不到讨论。');
 const getState=(id:string):BookState=>({book:book(id),workspace:workspace(id),discussions:store.list('discussions',id),messages:store.list('messages',id),summaries:store.list('summaries',id),receipts:store.list('receipts',id),sources:store.list('sources',id),concepts:store.list('concepts',id),runs:store.list('runs',id),activities:store.list('activities',id)});
 app.use('/api/*',async(c,next)=>{const host=c.req.header('host')?.split(':')[0];const origin=c.req.header('origin');const allowed=new Set([`http://127.0.0.1:${services.port||4317}`,`http://localhost:${services.port||4317}`,'http://127.0.0.1:5173','http://localhost:5173']);if(host&&!['127.0.0.1','localhost'].includes(host))throw new AppError('LOCAL_ONLY','服务仅接受本机访问。',403);if(origin&&!allowed.has(origin))throw new AppError('ORIGIN_DENIED','请求来源未获允许。',403);c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');await next()});
 app.onError((err,c)=>{const error=err instanceof AppError?err:err instanceof SyntaxError?new AppError('INVALID_JSON','请求不是有效的 JSON。'):err instanceof z.ZodError?new AppError('VALIDATION_ERROR','请求格式不正确，请检查输入。'):new AppError('INTERNAL_ERROR','操作未完成，已有记录保留。',500,true);return c.json({error:{code:error.code,message:error.message,retryable:error.retryable},requestId:randomUUID()},error.status as 400)});
 async function fileInput(c:any){const length=Number(c.req.header('content-length')||0);if(length>540*1024*1024)throw new AppError('FILE_TOO_LARGE','文件超过允许大小。',413);const data=await c.req.formData();const file=data.get('file');if(!(file instanceof File))throw new AppError('MISSING_FILE','请选择文件。');return {bytes:new Uint8Array(await file.arrayBuffer()),filename:file.name}}
 async function answer(id:string):Promise<Run>{
  const ctx=learning.buildInput(id,'discussion');
  return runs.start(ctx,'discussion',{onComplete:(event,run)=>{learning.appendAssistant(id,String(event.data.text??run.partialText),run.id)},onTerminal:(run)=>{if(run.status!=='completed'&&run.partialText)learning.appendAssistant(id,run.partialText,run.id,run.status==='failed'?'failed':'interrupted')}});
 }
 async function match(id:string,continueAnswer=false):Promise<Run>{
  const context=matching.buildInput(id);
  return runs.start(context,'matching',{onComplete:async(event)=>{const result=event.data.structuredOutput??event.data.text;await matching.complete(id,{result,toolResults:event.data.toolResults??[]})},onTerminal:async(run)=>{if(continueAnswer&&run.status!=='cancelled'){try{await answer(id)}catch(error){const d=discussion(id);store.put('runs',{id:randomUUID(),bookId:d.bookId,discussionId:d.id,purpose:'discussion',status:'failed',contextSnapshotId:context.id,sessionId:null,sessionReusable:false,partialText:'',result:null,error:'解析未能启动，请重新发送问题。',createdAt:now(),updatedAt:now()})}}}},{type:'object',properties:{candidates:{type:'array',items:{type:'object',properties:{url:{type:'string'},title:{type:'string'},language:{type:'string'},version:{type:'string'},quote:{type:'string'},locator:{type:'string'},reason:{type:'string'}},required:['url','title','language','version','quote','locator','reason'],additionalProperties:false}}},required:['candidates'],additionalProperties:false});
 }
 const runtimeInfo=async()=>({...(await adapter.probe()),provider:services.ai?.provider??'claude',models:await adapter.models?.()??[],model:(store.getIdempotent('ai.model') as string|undefined)??services.ai?.model??null});
 const RuntimePatchSchema=z.object({model:z.string().min(1).max(100)});
 app.get('/api/health',c=>c.json({status:'ok',version:'0.1.0'}));
 app.get('/api/runtime',async c=>c.json(await runtimeInfo()));
 app.patch('/api/runtime',async c=>{
  const {model}=RuntimePatchSchema.parse(await c.req.json());
  if(!adapter.models)throw new AppError('MODEL_SELECTION_UNSUPPORTED','当前 AI 运行时不支持模型选择。',400);
  const models=await adapter.models();
  if(!models.includes(model))throw new AppError('VALIDATION_ERROR','所选模型不在当前运行时的可用列表中。',400);
  store.setIdempotent('ai.model',model);
  return c.json(await runtimeInfo());
 });
 app.get('/api/books',c=>c.json(store.list('books')));app.post('/api/books',async c=>{const f=await fileInput(c);return c.json(await library.importBook(f.bytes,f.filename),201)});
 app.patch('/api/books/:id',async c=>{const previous=book(c.req.param('id'));const patch=BookMetadataPatchSchema.parse(await c.req.json());const updated={...previous,...patch};store.put('books',updated);return c.json(updated)});
 app.get('/api/books/:id/state',c=>c.json(getState(c.req.param('id'))));
 app.patch('/api/books/:id/workspace',async c=>{const b=book(c.req.param('id'));const patch=WorkspacePatchSchema.parse(await c.req.json());if(patch.position&&patch.position.fileVersionId!==b.fileVersionId)throw new AppError('FILE_VERSION_CONFLICT','阅读位置属于其他文件版本。',409);if(patch.activeDiscussionId&&discussion(patch.activeDiscussionId).bookId!==b.id)throw new AppError('BOOK_MISMATCH','讨论不属于这本书。',409);if(patch.collapsed?.some(id=>discussion(id).bookId!==b.id))throw new AppError('BOOK_MISMATCH','折叠记录不属于这本书。',409);const w={...workspace(b.id),...patch,updatedAt:now()};store.transaction(()=>{store.put('workspaces',w);if(patch.position)store.put('activities',{id:randomUUID(),bookId:b.id,...patch.position,createdAt:now()})});return c.json(w)});
 app.get('/api/files/:id',async c=>{const file=required(store.get('files',Id.parse(c.req.param('id'))));const bytes=await readFile(library.filePath(file.id));c.header('Content-Type',file.mediaType);c.header('Content-Security-Policy',"default-src 'none'; sandbox");return c.body(bytes)});
 app.post('/api/books/:id/originals',async c=>{const b=book(c.req.param('id'));const f=await fileInput(c);const file=await library.importOriginal(b.id,f.bytes,f.filename);matching.originalAdded(b.id,file.id);return c.json(file,201)});
 app.post('/api/analyses',async c=>{const request=AnalysisRequestSchema.parse(await c.req.json());const d=learning.createRoot(request);const w=workspace(d.bookId);store.put('workspaces',{...w,activeDiscussionId:d.id,updatedAt:now()});const run=supportsMatching()?await match(d.id,true):await answer(d.id);return c.json({discussionId:d.id,runId:run.id},202)});
 app.post('/api/branches',async c=>{const d=learning.createBranch(BranchRequestSchema.parse(await c.req.json()));const w=workspace(d.bookId);store.put('workspaces',{...w,activeDiscussionId:d.id,updatedAt:now()});const run=await answer(d.id);return c.json({discussionId:d.id,runId:run.id},202)});
 app.patch('/api/discussions/:id',async c=>c.json(learning.updateDiscussion(c.req.param('id'),DiscussionPatchSchema.parse(await c.req.json()))));
 app.post('/api/discussions/:id/messages',async c=>{const id=discussion(c.req.param('id')).id;if(runs.busy(id))throw new AppError('RUN_BUSY','请等待当前运行结束。',409,true);const {text}=MessageRequestSchema.parse(await c.req.json());learning.appendUser(id,text);const run=await answer(id);return c.json({runId:run.id},202)});
 app.post('/api/discussions/:id/summary',async c=>{const id=discussion(c.req.param('id')).id;const context=learning.buildInput(id,'summary');const run=await runs.start(context,'summary',{onComplete:(e)=>{const parsed=SummaryOutputSchema.safeParse(e.data.structuredOutput);if(!parsed.success)throw new AppError('INVALID_SUMMARY','未生成有效的结构化小结，请重试。',502,true);learning.createSummaryDraft(context.id,parsed.data.content)}},{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false});return c.json({runId:run.id},202)});
 app.post('/api/summaries/:id/confirm',async c=>c.json(learning.confirmSummary(c.req.param('id'),ConfirmRequestSchema.parse(await c.req.json()))));
 app.get('/api/discussions/:id/history',c=>{const d=discussion(c.req.param('id'));return c.json(store.list('summaries',d.bookId).filter(s=>s.discussionId===d.id&&s.confirmed).sort((a,b)=>b.version-a.version))});
 app.post('/api/discussions/:id/matching',async c=>{if(!supportsMatching())throw matchingUnsupported();const run=await match(discussion(c.req.param('id')).id);return c.json({runId:run.id},202)});
 app.patch('/api/sources/:id',async c=>c.json(matching.updateSource(c.req.param('id'),SourcePatchSchema.parse(await c.req.json()))));
 app.get('/api/runs/:id',c=>c.json(required(store.get('runs',Id.parse(c.req.param('id'))))));
 app.get('/api/runs/:id/events',c=>{const id=Id.parse(c.req.param('id'));required(store.get('runs',id));const raw=c.req.header('last-event-id')??c.req.query('after')??'0';let seq=Number(raw);if(!Number.isSafeInteger(seq)||seq<0)throw new AppError('INVALID_CURSOR','运行事件位置无效。');return streamSSE(c,async stream=>{let aborted=false;stream.onAbort(()=>{aborted=true});while(!aborted){for(const event of store.events(id,seq)){await stream.writeSSE({id:String(event.seq),event:'run',data:JSON.stringify(event)});seq=event.seq}const run=store.get('runs',id)!;if(['completed','failed','cancelled','interrupted'].includes(run.status))break;await stream.sleep(250)}})});
 app.post('/api/runs/:id/cancel',async c=>{await runs.cancel(Id.parse(c.req.param('id')));return c.json({ok:true})});
 app.post('/api/runs/:id/permission',async c=>{const p=PermissionRequestSchema.parse(await c.req.json());await runs.permission(Id.parse(c.req.param('id')),p.requestId,p.decision);return c.json({ok:true})});
 const reportParams=(c:any)=>{const timezone=c.req.query('timezone')||Intl.DateTimeFormat().resolvedOptions().timeZone;return {date:c.req.query('date')||dayAt(now(),timezone),timezone}};
 app.get('/api/books/:id/report',c=>{const p=reportParams(c);return c.json(buildReport(store,c.req.param('id'),p.date,p.timezone))});
 app.get('/api/books/:id/report.html',c=>{const p=reportParams(c);c.header('Content-Type','text/html; charset=utf-8');c.header('Content-Disposition','attachment; filename="MomentRead-reading-summary.html"');return c.body(renderReport(buildReport(store,c.req.param('id'),p.date,p.timezone)))});
 app.post('/api/books/:id/report',async c=>{const p=reportParams(c);const report=buildReport(store,c.req.param('id'),p.date,p.timezone);const d=store.list('discussions',report.book.id).at(-1);if(!d)throw new AppError('NO_DISCUSSION','先完成一次选段讨论，再生成总结。');const ctx={id:randomUUID(),bookId:d.bookId,discussionId:d.id,discussionRevision:d.revision,input:`只根据以下真实记录用中文写阅读总结、未解问题和下一次阅读建议。不得推测掌握率或阅读时长。原文待核的内容保留不确定。\n${JSON.stringify({book:report.book.title,date:report.date,chapter:report.activities.at(-1)?.chapter,summaries:report.summaries.map(s=>s.content),concepts:report.concepts.map(s=>({term:s.title,context:s.context}))})}`,messageIds:[],summaryDependencies:report.summaries.map(s=>({summaryId:s.id,version:s.version})),sourceIds:[],createdAt:now()};store.put('contexts',ctx);const run=await runs.start(ctx,'daily',{reportTarget:p,result:e=>({advice:String(e.data.text??''),date:p.date,timezone:p.timezone,summaryIds:report.summaries.map(s=>s.id)})});return c.json({runId:run.id},202)});
 app.post('/api/backups',async c=>{const result=await library.backup();backupDownloads.set(result.id,result.path);return c.json({id:result.id})});
 app.get('/api/backups/:id',async c=>{const path=backupDownloads.get(c.req.param('id'));if(!path)throw new AppError('NOT_FOUND','下载链接已失效，请重新创建备份。',404);c.header('Content-Type','application/zip');c.header('Content-Disposition','attachment; filename="MomentRead-backup.zip"');return c.body(await readFile(path))});
 app.post('/api/restore',async c=>{if(store.list('books').length)throw new AppError('RESTORE_REQUIRES_EMPTY','恢复只允许在空书库执行。请保留现有书库并使用新的数据目录。',409);const f=await fileInput(c);await library.restore(f.bytes);store.transaction(()=>{
  // CLI history is outside the portable backup. Continue from saved product context.
  for(const session of store.list('sessions'))store.put('sessions',{...session,reusable:false});
  for(const run of store.list('runs'))if(['queued','running','permission'].includes(run.status))store.put('runs',{...run,status:'interrupted',sessionReusable:false,error:'备份中的生成任务已中断，可以从保存的讨论继续。',updatedAt:now()});
 });return c.json({ok:true})});
 return {app,runs};
}
