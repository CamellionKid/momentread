import type {EntityMap,RunEvent,RunPurpose,TextReference,ReadingPosition,Book,FileVersion} from './index';
export interface Store {
 get<K extends keyof EntityMap>(kind:K,id:string):EntityMap[K]|undefined;
 list<K extends keyof EntityMap>(kind:K,bookId?:string):EntityMap[K][];
 put<K extends keyof EntityMap>(kind:K,value:EntityMap[K]):void;
 remove<K extends keyof EntityMap>(kind:K,id:string):void;
 transaction<T>(fn:()=>T):T;
 appendEvent(event:RunEvent):void;
 events(runId:string,after?:number):RunEvent[];
 getIdempotent(key:string):unknown|undefined;
 setIdempotent(key:string,value:unknown):void;
 close():void;
}
export interface BookLibrary {
 importBook(bytes:Uint8Array,filename:string):Promise<Book>;
 importOriginal(bookId:string,bytes:Uint8Array,filename:string):Promise<FileVersion>;
 filePath(fileId:string):string;
 backup():Promise<{id:string;path:string}>;
 restore(bytes:Uint8Array):Promise<void>;
}
export interface RuntimeProbe {installed:boolean;version:string|null;authReported:boolean;invocationVerified:boolean;message:string;}
export interface StartRun {runId:string;bookId:string;discussionId:string;purpose:RunPurpose;contextSnapshotId:string;input:string;session:{mode:'new'}|{mode:'resume';cliSessionId:string};outputSchema?:Record<string,unknown>;}
export interface RunHandle {runId:string;events:AsyncIterable<RunEvent>;}
export interface ClaudeAdapter {probe():Promise<RuntimeProbe>;start(request:StartRun):Promise<RunHandle>;cancel(runId:string):Promise<void>;answerPermission(runId:string,requestId:string,decision:'allowOnce'|'deny'):Promise<void>;}
export interface ReaderHandle {restorePosition(position:ReadingPosition):Promise<void>;navigateToReference(reference:TextReference):Promise<void>;setTypography(fontSize:number):void;}
export interface ReaderProps {book:Book;fileUrl:string;position:ReadingPosition|null;fontSize:number;onReady:()=>void;onSelection:(reference:TextReference)=>void;onRelocate:(position:ReadingPosition)=>void;onError:(message:string)=>void;}

export interface LearningService {
 createRoot(request:import('./index').AnalysisRequest):import('./index').Discussion;
 createBranch(request:import('./index').BranchRequest):import('./index').Discussion;
 buildInput(discussionId:string,purpose:RunPurpose,question?:string):import('./index').ContextSnapshot;
 appendUser(discussionId:string,text:string):import('./index').Message;
 appendAssistant(discussionId:string,text:string,runId:string,status?:'complete'|'interrupted'|'failed'):import('./index').Message;
 createSummaryDraft(contextId:string,content:string):import('./index').SummaryVersion;
 confirmSummary(summaryId:string,request:import('./index').ConfirmRequest):{summary:import('./index').SummaryVersion;parentId:string|null};
 updateDiscussion(id:string,patch:{draft?:string;scrollTop?:number}):import('./index').Discussion;
}
export interface MatchingService {
 buildInput(discussionId:string):import('./index').ContextSnapshot;
 complete(discussionId:string,result:unknown):Promise<import('./index').SourceCandidate[]>;
 updateSource(id:string,patch:{selected?:boolean;verification?:'unverified'|'confirmed'|'conflict'}):import('./index').SourceCandidate;
 originalAdded(bookId:string,fileVersionId:string):void;
}
