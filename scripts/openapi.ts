import {writeFileSync} from 'node:fs';
import {z} from 'zod';
import {entitySchemas,EventSchema,AnalysisRequestSchema,BranchRequestSchema,ConfirmRequestSchema} from '../shared/contracts/index';
import * as http from '../shared/contracts/http';
const schemas=Object.fromEntries(Object.entries({...entitySchemas,RunEvent:EventSchema,AnalysisRequest:AnalysisRequestSchema,BranchRequest:BranchRequestSchema,ConfirmRequest:ConfirmRequestSchema,...http}).map(([name,schema])=>{const json=z.toJSONSchema(schema);delete json.$schema;return [name,json]}));
type Endpoint=[method:string,path:string,input:string|undefined,output:string,status?:number];
const definitions:Endpoint[]=[
 ['get','/health',undefined,'HealthResponseSchema'],['get','/runtime',undefined,'RuntimeResponseSchema'],
 ['get','/books',undefined,'BookListResponseSchema'],['post','/books','file','books',201],
 ['patch','/books/{id}','BookMetadataPatchSchema','books'],
 ['get','/books/{id}/state',undefined,'BookStateResponseSchema'],['patch','/books/{id}/workspace','WorkspacePatchSchema','workspaces'],
 ['get','/files/{id}',undefined,'binary'],['post','/books/{id}/originals','file','files',201],
 ['post','/analyses','AnalysisRequest','DiscussionStartResponseSchema',202],['post','/branches','BranchRequest','DiscussionStartResponseSchema',202],
 ['patch','/discussions/{id}','DiscussionPatchSchema','discussions'],['post','/discussions/{id}/messages','MessageRequestSchema','RunStartResponseSchema',202],
 ['post','/discussions/{id}/summary',undefined,'RunStartResponseSchema',202],['post','/summaries/{id}/confirm','ConfirmRequest','ConfirmResponseSchema'],
 ['get','/discussions/{id}/history',undefined,'HistoryResponseSchema'],['post','/discussions/{id}/matching',undefined,'RunStartResponseSchema',202],
 ['patch','/sources/{id}','SourcePatchSchema','sources'],['get','/runs/{id}',undefined,'runs'],['get','/runs/{id}/events',undefined,'sse'],
 ['post','/runs/{id}/cancel',undefined,'OkResponseSchema'],['post','/runs/{id}/permission','PermissionRequestSchema','OkResponseSchema'],
 ['get','/books/{id}/report',undefined,'DailyReportResponseSchema'],['post','/books/{id}/report',undefined,'RunStartResponseSchema',202],
 ['get','/books/{id}/report.html',undefined,'html'],['post','/backups',undefined,'BackupResponseSchema'],
 ['get','/backups/{id}',undefined,'zip'],['post','/restore','file','OkResponseSchema']];
const jsonContent=(name:string)=>({'application/json':{schema:{$ref:`#/components/schemas/${name}`}}});
const paths:Record<string,Record<string,unknown>>={};
for(const [method,path,input,output,status=200] of definitions){
 const media:Record<string,string>={binary:'application/octet-stream',zip:'application/zip',html:'text/html',sse:'text/event-stream'};
 const content=media[output]?{[media[output]]:{schema:{type:'string',...(['binary','zip'].includes(output)?{format:'binary'}:{})}}}:jsonContent(output);
 const parameters:unknown[]=[];
 if(path.includes('{id}'))parameters.push({name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}});
 if(path.includes('/report'))parameters.push({name:'date',in:'query',schema:{type:'string',format:'date'}},{name:'timezone',in:'query',schema:{type:'string'},example:'Asia/Shanghai'});
 if(output==='sse')parameters.push({name:'after',in:'query',schema:{type:'integer',minimum:0,default:0}},{name:'Last-Event-ID',in:'header',schema:{type:'integer',minimum:0},description:'优先于 after；只补读持久事件，不创建新的模型运行。'});
 const operation:Record<string,unknown>={operationId:`${method}_${path.replace(/\W+/g,'_')}`,parameters,responses:{
  [status]:{description:output==='sse'?'SSE event: run；id: seq；data: RunEvent JSON。':status===202?'已接受，使用 runId 订阅进度。':'成功',content},
  ...Object.fromEntries([400,403,404,409,413,429,500,502,503].map(code=>[code,{description:'失败；错误码、可操作说明、可重试性与请求 ID。',content:jsonContent('ErrorResponseSchema')}]))}};
 if(input)operation.requestBody={required:true,content:input==='file'?{'multipart/form-data':{schema:{type:'object',properties:{file:{type:'string',format:'binary'}},required:['file']}}}:jsonContent(input)};
 (paths['/api'+path]??={})[method]=operation;
}
writeFileSync('docs/development/openapi.json',JSON.stringify({openapi:'3.1.0',info:{title:'MomentRead local API',version:'1.0.0'},servers:[{url:'http://127.0.0.1:4317'}],paths,components:{schemas}},null,2)+'\n');
