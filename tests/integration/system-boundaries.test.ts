import {afterEach, describe, expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {z} from 'zod';
import {BookSchema, RunSchema} from '../../shared/contracts';
import {BookListResponseSchema, DiscussionStartResponseSchema, ErrorResponseSchema} from '../../shared/contracts/http';
import {readStoreSnapshot, restoreStoreSnapshot, serializeStore} from '../../server/storage';
import {ControlledAdapter, importSynthetic, makeHarness, reference, syntheticEpub, terminalRun, waitFor} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(adapter?:ControlledAdapter,existingDir?:string){const h=await makeHarness(adapter,existingDir);opened.push(h);return h;}
async function abruptRestart(h:Harness){
  // No cancel, final event, or graceful run shutdown is sent. Recreate the public
  // services against the same durable files to exercise startup reconciliation.
  await h.dispose(false);opened.splice(opened.indexOf(h),1);
  return harness(undefined,h.dir);
}
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
async function expectRejected(response:Response){expect(response.status,await response.clone().text()).toBeGreaterThanOrEqual(400);expect(response.status).toBeLessThan(500);ErrorResponseSchema.parse(await response.json());}

describe('independent restart and restored-download boundaries',()=>{
  it('a hard restart during resume invalidates the old successful session before the next message',async()=>{
    const adapter=new ControlledAdapter();const h=await harness(adapter);const book=await importSynthetic(h);const discussion=h.learning.createRoot({source:reference(book),question:'合成初始问题'});
    const firstResponse=await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'先完成一次会话'});expect(firstResponse.ok).toBe(true);const firstId=(await firstResponse.json()).runId;const first=await terminalRun(h,firstId);
    expect(first).toMatchObject({status:'completed',sessionReusable:true});expect(first.sessionId).toBeTruthy();
    adapter.scripts.push(control=>control.emit('text_delta',{text:'恢复中但尚未完成的合成片段'}));
    const resumedResponse=await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'第二次恢复旧会话'});expect(resumedResponse.ok).toBe(true);const resumedId=(await resumedResponse.json()).runId;
    await waitFor(async()=>RunSchema.parse(await (await h.request(`/api/runs/${resumedId}`)).json()),run=>run.status==='running'&&run.partialText.length>0,'resumed run persisted while active');
    expect(adapter.starts[1].session).toEqual({mode:'resume',cliSessionId:first.sessionId});expect(adapter.cancellations).toEqual([]);
    const restarted=await abruptRestart(h);
    const interrupted=RunSchema.parse(await (await restarted.request(`/api/runs/${resumedId}`)).json());expect(interrupted).toMatchObject({status:'interrupted',sessionReusable:false});expect(restarted.adapter.starts).toHaveLength(0);
    const nextResponse=await restarted.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'重启后继续当前问题'});expect(nextResponse.ok).toBe(true);const nextId=(await nextResponse.json()).runId;expect((await terminalRun(restarted,nextId)).status).toBe('completed');
    expect(restarted.adapter.starts).toHaveLength(1);expect(restarted.adapter.starts[0].session).toEqual({mode:'new'});
  });

  it('restoring a crafted legacy backup does not grant download access to an arbitrary local path',async()=>{
    const source=await harness();await importSynthetic(source);const backupId=(await (await source.request('/api/backups','POST')).json()).id;
    const entries=unzipSync(new Uint8Array(await (await source.request(`/api/backups/${backupId}`)).arrayBuffer()));
    const manifest=JSON.parse(strFromU8(entries['manifest.json'])) as {database:{path:string;sha256:string}};
    const snapshot=readStoreSnapshot(entries[manifest.database.path]);
    const forgedId=randomUUID();const marker=`SYNTHETIC-LOCAL-SECRET-${randomUUID()}`;const sentinelPath=join(source.dir,'outside-backup-downloads.txt');await writeFile(sentinelPath,marker);
    // This is the documented legacy key/value supplied by the owning module.
    // Construct the malicious archive through public storage serialization,
    // then update its declared digest so checksum rejection cannot mask the test.
    snapshot.idempotency.push({key:`backup-download:${forgedId}`,value:JSON.stringify({path:sentinelPath})});
    const archiveWriter=await harness();restoreStoreSnapshot(archiveWriter.store,snapshot);const database=serializeStore(archiveWriter.store);
    expect(readStoreSnapshot(database).idempotency).toContainEqual({key:`backup-download:${forgedId}`,value:JSON.stringify({path:sentinelPath})});
    entries[manifest.database.path]=Uint8Array.from(database);manifest.database.sha256=createHash('sha256').update(database).digest('hex');entries['manifest.json']=strToU8(JSON.stringify(manifest));
    const target=await harness();const restored=await target.upload('/api/restore',zipSync(entries),'crafted-legacy-backup.zip');
    if(restored.ok){expect(await restored.json()).toEqual({ok:true});}
    else {await expectRejected(restored);expect(await (await target.request('/api/books')).json()).toEqual([]);}
    const leaked=await target.request(`/api/backups/${forgedId}`);expect(await leaked.clone().text()).not.toContain(marker);await expectRejected(leaked);
    expect(await readFile(sentinelPath,'utf8')).toBe(marker);
  });

  it('backup download IDs expire on service restart and a newly generated backup remains downloadable',async()=>{
    const h=await harness();await importSynthetic(h);const oldId=(await (await h.request('/api/backups','POST')).json()).id;
    const oldDownload=await h.request(`/api/backups/${oldId}`);expect(oldDownload.ok).toBe(true);expect(Object.keys(unzipSync(new Uint8Array(await oldDownload.arrayBuffer())))).toContain('manifest.json');
    const restarted=await abruptRestart(h);await expectRejected(await restarted.request(`/api/backups/${oldId}`));
    const newId=(await (await restarted.request('/api/backups','POST')).json()).id;expect(newId).not.toBe(oldId);const fresh=await restarted.request(`/api/backups/${newId}`);expect(fresh.ok).toBe(true);expect(Object.keys(unzipSync(new Uint8Array(await fresh.arrayBuffer())))).toContain('manifest.json');
  });
});

type JsonObject=Record<string,any>;
async function expectDocumented(response:Response,method:string,path:string,status:number,bodySchema:z.ZodType){
  const document=JSON.parse(await readFile(new URL('../../docs/development/openapi.json',import.meta.url),'utf8')) as JsonObject;
  expect(response.status,await response.clone().text()).toBe(status);
  const documented=document.paths[path]?.[method]?.responses[String(status)];
  expect(documented,`${method.toUpperCase()} ${path} must document status ${status}`).toBeDefined();
  let schema=documented?.content?.['application/json']?.schema;
  expect(schema,`${method.toUpperCase()} ${path} ${status} must document its JSON response`).toBeDefined();
  if(schema?.$ref){expect(schema.$ref).toMatch(/^#\//);schema=schema.$ref.slice(2).split('/').reduce((current:JsonObject,key:string)=>current[key.replace(/~1/g,'/').replace(/~0/g,'~')],document);}
  const expected=z.toJSONSchema(bodySchema) as JsonObject;delete expected.$schema;
  expect(schema).toMatchObject(expected);
  const body=await response.json();expect(bodySchema.safeParse(body).success,JSON.stringify(body)).toBe(true);
  return body;
}

describe('live HTTP responses agree with generated OpenAPI status and body schemas',()=>{
  it('GET books returns 200 and an array schema',async()=>{const h=await harness();await importSynthetic(h);await expectDocumented(await h.request('/api/books'),'get','/api/books',200,BookListResponseSchema);});
  it('POST books returns 201 and one Book schema',async()=>{const h=await harness();await expectDocumented(await h.upload('/api/books',syntheticEpub()),'post','/api/books',201,BookSchema);});
  it('POST analyses returns 202 with discussionId and runId',async()=>{const h=await harness();const book=await importSynthetic(h);await expectDocumented(await h.request('/api/analyses','POST',{source:reference(book),question:'公开契约合成测试'}),'post','/api/analyses',202,DiscussionStartResponseSchema);await waitFor(()=>h.state(book.id),state=>state.runs.length===2&&state.runs.every(run=>['completed','failed'].includes(run.status)),'analysis chain complete');});
  it('GET a real run returns 200 with the Run schema',async()=>{const h=await harness();const book=await importSynthetic(h);const discussion=h.learning.createRoot({source:reference(book),question:'合成问题'});const {runId}=await (await h.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'运行契约'})).json();await terminalRun(h,runId);await expectDocumented(await h.request(`/api/runs/${runId}`),'get','/api/runs/{id}',200,RunSchema);});
  it('invalid analysis returns 400 with the structured Error schema',async()=>{const h=await harness();await expectDocumented(await h.request('/api/analyses','POST',{}),'post','/api/analyses',400,ErrorResponseSchema);expect(h.adapter.starts).toHaveLength(0);});
  it('a missing run returns 404 with the structured Error schema',async()=>{const h=await harness();await expectDocumented(await h.request(`/api/runs/${randomUUID()}`),'get','/api/runs/{id}',404,ErrorResponseSchema);});
});
