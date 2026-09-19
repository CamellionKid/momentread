import busboy from 'busboy';
import {extname} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {AppError} from '../shared/contracts';
import {EPUB_LIMITS, BACKUP_LIMITS, MAX_ORIGINAL_TEXT_BYTES} from './books/archive';

export const BODY_LIMITS={json:1024*1024,epub:EPUB_LIMITS.compressed,txt:MAX_ORIGINAL_TEXT_BYTES,backup:BACKUP_LIMITS.compressed,overhead:64*1024};
type UploadKind='book'|'original'|'backup';
const tooLarge=()=>new AppError('FILE_TOO_LARGE','请求或文件超过允许大小。',413);
const invalid=()=>new AppError('INVALID_UPLOAD','请上传一个有效文件。',400);
async function checkLength(request:Request,limit:number) {
  const declared=request.headers.get('content-length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){
    await request.body?.cancel().catch(()=>{});
    throw tooLarge();
  }
}

export async function jsonInput(request:Request) {
  await checkLength(request,BODY_LIMITS.json);
  const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader)try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>BODY_LIMITS.json)throw tooLarge();chunks.push(value);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
}

/** Count wire bytes before parsing, then count file bytes before retaining them.
 * The request reader is cancelled by pipeline on any size/format failure. */
export async function fileInput(request:Request,kind:UploadKind,limits=BODY_LIMITS) {
  const fileMaximum=kind==='backup'?limits.backup:limits.epub;
  await checkLength(request,fileMaximum+limits.overhead);
  if(!request.body||!/^multipart\/form-data(?:;|$)/i.test(request.headers.get('content-type')??'')){await request.body?.cancel().catch(()=>{});throw invalid();}
  let parser:ReturnType<typeof busboy>;
  try{parser=busboy({headers:{'content-type':request.headers.get('content-type')!},defParamCharset:'utf8',limits:{files:1,fields:0,parts:2,fileSize:fileMaximum+1,headerPairs:100}});}
  catch{await request.body.cancel().catch(()=>{});throw invalid();}
  let wireBytes=0;let fileBytes=0;let filename='';let fileLimit=fileMaximum;
  const chunks:Buffer[]=[];
  const meter=new Transform({transform(chunk:Buffer,_encoding,callback){wireBytes+=chunk.length;callback(wireBytes>fileMaximum+limits.overhead?tooLarge():null,chunk);}});
  const fail=(error:Error)=>meter.destroy(error);
  parser.on('file',(name,file,info)=>{
    file.on('error',()=>{}); // pipeline owns error reporting, including file teardown.
    if(name!=='file'||typeof info.filename!=='string'||!info.filename){file.resume();fail(invalid());return;}
    filename=info.filename;
    const extension=extname(filename).toLowerCase();
    if((kind==='book'&&extension!=='.epub')||(kind==='original'&&!['.epub','.txt'].includes(extension))){file.resume();fail(invalid());return;}
    fileLimit=kind==='original'&&extension==='.txt'?limits.txt:fileMaximum;
    file.on('limit',()=>fail(tooLarge()));
    file.on('data',(chunk:Buffer)=>{fileBytes+=chunk.length;if(fileBytes>fileLimit)fail(tooLarge());else chunks.push(chunk);});
  });
  parser.on('filesLimit',()=>fail(invalid()));parser.on('fieldsLimit',()=>fail(invalid()));parser.on('partsLimit',()=>fail(invalid()));
  try{await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream),meter,parser);}
  catch(error){if(error instanceof AppError)throw error;throw invalid();}
  if(!filename)throw new AppError('MISSING_FILE','请选择文件。');
  return {filename,bytes:Buffer.concat(chunks,fileBytes)};
}
