import type {Book,BookState,Workspace,Discussion,AnalysisRequest,BranchRequest,SummaryVersion,SourceCandidate,Run,DailyReport,FileVersion} from '../shared/contracts/index';
import type {RuntimeProbe} from '../shared/contracts/ports';
export class ApiError extends Error {constructor(public code:string,message:string,public retryable:boolean,public status:number){super(message)}}
async function request<T>(path:string,options:RequestInit={}):Promise<T>{
 const response=await fetch('/api'+path,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers}});
 if(!response.ok){const body=await response.json().catch(()=>({error:{code:'NETWORK_ERROR',message:'请求没有完成，请检查连接。',retryable:true}}));throw new ApiError(body.error.code,body.error.message,body.error.retryable,response.status)}
 return response.json();
}
const post=<T>(path:string,body?:unknown)=>request<T>(path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body)});
const patch=<T>(path:string,body:unknown)=>request<T>(path,{method:'PATCH',body:JSON.stringify(body)});
function upload<T>(path:string,file:File){const body=new FormData();body.append('file',file);return request<T>(path,{method:'POST',body})}
export const api={
 books:()=>request<Book[]>('/books'),runtime:()=>request<RuntimeProbe>('/runtime'),state:(id:string)=>request<BookState>(`/books/${id}/state`),
 importBook:(file:File)=>upload<Book>('/books',file),importOriginal:(id:string,file:File)=>upload<FileVersion>(`/books/${id}/originals`,file),
 bookMetadata:(id:string,body:Partial<Pick<Book,'title'|'author'|'language'|'translator'|'edition'|'identifier'>>)=>patch<Book>(`/books/${id}`,body),
 workspace:(id:string,body:Partial<Pick<Workspace,'position'|'activeDiscussionId'|'collapsed'|'fontSize'>>)=>patch<Workspace>(`/books/${id}/workspace`,body),
 analyze:(body:AnalysisRequest)=>post<{discussionId:string;runId:string}>('/analyses',body),branch:(body:BranchRequest)=>post<{discussionId:string;runId:string}>('/branches',body),
 discussion:(id:string,body:{draft?:string;scrollTop?:number})=>patch<Discussion>(`/discussions/${id}`,body),
 message:(id:string,text:string)=>post<{runId:string}>(`/discussions/${id}/messages`,{text}),summary:(id:string)=>post<{runId:string}>(`/discussions/${id}/summary`),
 confirm:(id:string,content:string,requestId:string)=>post<{summary:SummaryVersion;parentId:string|null}>(`/summaries/${id}/confirm`,{content,requestId}),
 history:(id:string)=>request<SummaryVersion[]>(`/discussions/${id}/history`),matching:(id:string)=>post<{runId:string}>(`/discussions/${id}/matching`),
 source:(id:string,body:{selected?:boolean;verification?:'unverified'|'confirmed'|'conflict'})=>patch<SourceCandidate>(`/sources/${id}`,body),
 run:(id:string)=>request<Run>(`/runs/${id}`),cancel:(id:string)=>post<{ok:true}>(`/runs/${id}/cancel`),permission:(id:string,requestId:string,decision:'allowOnce'|'deny')=>post<{ok:true}>(`/runs/${id}/permission`,{requestId,decision}),
 report:(id:string,date:string,timezone:string)=>request<DailyReport>(`/books/${id}/report?date=${date}&timezone=${encodeURIComponent(timezone)}`),
 generateReport:(id:string,date:string,timezone:string)=>post<{runId:string}>(`/books/${id}/report?date=${date}&timezone=${encodeURIComponent(timezone)}`),
 backup:()=>post<{id:string}>('/backups'),restore:(file:File)=>upload<{ok:true}>('/restore',file),
};
