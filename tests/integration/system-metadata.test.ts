import {afterEach, describe, expect, it} from 'vitest';
import {BookSchema} from '../../shared/contracts';
import {ErrorResponseSchema} from '../../shared/contracts/http';
import {importSynthetic, makeHarness, reference} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(existingDir?:string){const h=await makeHarness(undefined,existingDir);opened.push(h);return h;}
async function reopen(h:Harness){await h.dispose(false);opened.splice(opened.indexOf(h),1);return harness(h.dir);}
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
async function bytes(h:Harness,fileVersionId:string){const response=await h.request(`/api/files/${fileVersionId}`);expect(response.status).toBe(200);return new Uint8Array(await response.arrayBuffer());}

describe('independent book metadata completion over HTTP',()=>{
  it('F01: persists completed metadata through restart without changing EPUB bytes, file identity or reading references',async()=>{
    const h=await harness();const original=await importSynthetic(h,'合成原书名');const beforeBytes=await bytes(h,original.fileVersionId);
    const discussion=h.learning.createRoot({source:reference(original,2),question:'第二章的合成选段'});
    const position={fileVersionId:original.fileVersionId,cfi:'epubcfi(/6/4[chapter2]!/4/4/1:6)',progress:0.64,chapter:'第二章'};
    expect((await h.request(`/api/books/${original.id}/workspace`,'PATCH',{position,activeDiscussionId:discussion.id,fontSize:28})).status).toBe(200);
    const patch={title:'补录后的合成书名',author:'补录的合成作者',language:'de',translator:'合成译者',edition:'2026 年合成修订版',identifier:'synthetic:metadata:001'};
    const response=await h.request(`/api/books/${original.id}`,'PATCH',patch);expect(response.status,await response.clone().text()).toBe(200);
    expect(BookSchema.parse(await response.json())).toMatchObject({...patch,id:original.id,fileVersionId:original.fileVersionId,createdAt:original.createdAt});
    expect(await bytes(h,original.fileVersionId)).toEqual(beforeBytes);
    const restarted=await reopen(h);const state=await restarted.state(original.id);
    expect(state.book).toMatchObject({...patch,id:original.id,fileVersionId:original.fileVersionId,createdAt:original.createdAt});
    expect(state.workspace).toMatchObject({position,activeDiscussionId:discussion.id,fontSize:28});
    expect(state.discussions.find(item=>item.id===discussion.id)?.source).toEqual(reference(original,2));
    expect(await bytes(restarted,original.fileVersionId)).toEqual(beforeBytes);expect(restarted.adapter.starts).toHaveLength(0);
  });

  it('reads a persisted legacy Book containing only the previous required fields and allows later optional metadata completion',async()=>{
    const h=await harness();const imported=await importSynthetic(h);const {id,title,author,language,fileVersionId,createdAt}=imported;
    // Public Store fixture emulates an existing database written before the
    // optional metadata fields existed, without migrating or editing files.
    const legacy={id,title,author,language,fileVersionId,createdAt};h.store.put('books',legacy);
    const restarted=await reopen(h);const state=await restarted.state(id);expect(state.book).toEqual(legacy);
    const list=await restarted.request('/api/books');expect(list.status).toBe(200);expect(await list.json()).toEqual([legacy]);
    const patch=await restarted.request(`/api/books/${id}`,'PATCH',{translator:'后来补录的合成译者',edition:'合成旧版',identifier:'synthetic:legacy:001'});
    expect(patch.status,await patch.clone().text()).toBe(200);expect(BookSchema.parse(await patch.json())).toEqual({...legacy,translator:'后来补录的合成译者',edition:'合成旧版',identifier:'synthetic:legacy:001'});
  });

  it('accepts each documented maximum length and allows optional metadata to be cleared',async()=>{
    const h=await harness();const book=await importSynthetic(h);const boundary={title:'题'.repeat(500),author:'作'.repeat(500),language:'l'.repeat(100),translator:'译'.repeat(500),edition:'版'.repeat(1000),identifier:'i'.repeat(500)};
    const saved=await h.request(`/api/books/${book.id}`,'PATCH',boundary);expect(saved.status,await saved.clone().text()).toBe(200);expect(BookSchema.parse(await saved.json())).toMatchObject(boundary);
    const cleared=await h.request(`/api/books/${book.id}`,'PATCH',{translator:'',edition:'',identifier:''});expect(cleared.status).toBe(200);expect(BookSchema.parse(await cleared.json())).toMatchObject({...boundary,translator:'',edition:'',identifier:''});
  });

  it.each([
    ['unknown key',{translator:'不得部分保存',unknownMetadata:'not allowed'}],
    ['empty title',{title:''}],
    ['whitespace-only title',{title:'  \t '}],
    ['title over 500',{title:'题'.repeat(501)}],
    ['author over 500',{author:'作'.repeat(501)}],
    ['language over 100',{language:'l'.repeat(101)}],
    ['translator over 500',{translator:'译'.repeat(501)}],
    ['edition over 1000',{edition:'版'.repeat(1001)}],
    ['identifier over 500',{identifier:'i'.repeat(501)}],
  ])('rejects %s atomically with a structured client error',async(_label,patch)=>{
    const h=await harness();const book=await importSynthetic(h);const before=await h.state(book.id);const beforeBytes=await bytes(h,book.fileVersionId);
    const response=await h.request(`/api/books/${book.id}`,'PATCH',patch);expect(response.status,await response.clone().text()).toBe(400);ErrorResponseSchema.parse(await response.json());
    expect(await h.state(book.id)).toEqual(before);expect(await bytes(h,book.fileVersionId)).toEqual(beforeBytes);expect(h.adapter.starts).toHaveLength(0);
  });
});
