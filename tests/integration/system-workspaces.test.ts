import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {WorkspaceSchema} from '../../shared/contracts';
import {importSynthetic,makeHarness,reference} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(existingDir?:string){const value=await makeHarness(undefined,existingDir);opened.push(value);return value;}
async function restart(value:Harness){await value.dispose(false);opened.splice(opened.indexOf(value),1);return harness(value.dir);}
afterEach(async()=>{for(const value of opened.splice(0))await value.dispose();});

describe('independent workspace identity and legacy-position regression',()=>{
  it('imports one workspace per book and keeps the same workspace through reads, saves, and service reopening',async()=>{
    const h=await harness();const book=await importSynthetic(h);
    expect(h.store.list('workspaces',book.id)).toHaveLength(1);
    const initial=h.store.list('workspaces',book.id)[0];expect(initial).toMatchObject({id:book.id,bookId:book.id});
    const position={fileVersionId:book.fileVersionId,cfi:'epubcfi(/6/4[chapter2]!/4/4/1:6)',progress:0.63,chapter:'第二章'};
    expect((await h.state(book.id)).workspace.id).toBe(initial.id);
    const saved=await h.request(`/api/books/${book.id}/workspace`,'PATCH',{position,fontSize:28});expect(saved.status).toBe(200);
    expect(WorkspaceSchema.parse(await saved.json())).toMatchObject({id:initial.id,position,fontSize:28});
    await h.state(book.id);await h.state(book.id);expect(h.store.list('workspaces',book.id)).toHaveLength(1);
    const reopened=await restart(h);expect((await reopened.state(book.id)).workspace).toMatchObject({id:initial.id,position,fontSize:28});
    expect(reopened.store.list('workspaces',book.id)).toHaveLength(1);expect(reopened.adapter.starts).toHaveLength(0);
  });

  it('reopens a legacy non-book workspace id without losing position, active node, folding, or typography',async()=>{
    const h=await harness();const book=await importSynthetic(h);const discussion=h.learning.createRoot({source:reference(book,2),question:'合成旧工作区讨论'});
    const workspace=h.store.list('workspaces',book.id)[0];
    const position={fileVersionId:book.fileVersionId,cfi:'epubcfi(/6/4[chapter2]!/4/4/1:9)',progress:0.72,chapter:'第二章'};
    const legacy={...workspace,id:randomUUID(),position,activeDiscussionId:discussion.id,collapsed:[discussion.id],fontSize:30,updatedAt:'2026-09-10T00:00:00.000Z'};
    // Build the historical public entity shape in disposable synthetic storage.
    // No SQL or private migration logic is consulted; retaining the old row is allowed.
    h.store.transaction(()=>{for(const row of h.store.list('workspaces',book.id))h.store.remove('workspaces',row.id);h.store.put('workspaces',legacy);});
    expect(h.store.list('workspaces',book.id)).toEqual([legacy]);
    const reopened=await restart(h);const state=await reopened.state(book.id);
    expect(state.workspace).toMatchObject({bookId:book.id,position,activeDiscussionId:discussion.id,collapsed:[discussion.id],fontSize:30});
    const saved=await reopened.request(`/api/books/${book.id}/workspace`,'PATCH',{fontSize:32});expect(saved.status).toBe(200);
    expect(WorkspaceSchema.parse(await saved.json())).toMatchObject({position,activeDiscussionId:discussion.id,collapsed:[discussion.id],fontSize:32});
    const again=await restart(reopened);expect((await again.state(book.id)).workspace).toMatchObject({position,activeDiscussionId:discussion.id,collapsed:[discussion.id],fontSize:32});
    expect(again.adapter.starts).toHaveLength(0);
  });
});
