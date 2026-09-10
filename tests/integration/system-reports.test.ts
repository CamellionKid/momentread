import {afterEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {DailyReportResponseSchema, ErrorResponseSchema} from '../../shared/contracts/http';
import type {Book, Discussion} from '../../shared/contracts';
import {ControlledAdapter, importSynthetic, makeHarness, reference, terminalRun, waitFor} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(adapter?:ControlledAdapter){const h=await makeHarness(adapter);opened.push(h);return h;}
afterEach(async()=>{for(const h of opened.splice(0))await h.dispose();});
function confirmedRoot(h:Harness,book:Book):Discussion {
  const discussion=h.learning.createRoot({source:reference(book),question:'合成报告问题'});
  const preview=h.learning.createSummaryDraft(h.learning.buildInput(discussion.id,'summary').id,'本书已确认的合成结论');
  h.learning.confirmSummary(preview.id,{requestId:randomUUID(),content:'本书已确认的合成结论'});
  return discussion;
}
const reportUrl=(bookId:string,date:string,timezone:string,html=false)=>`/api/books/${bookId}/report${html?'.html':''}?${new URLSearchParams({date,timezone})}`;
async function readReport(h:Harness,bookId:string,date:string,timezone:string){const response=await h.request(reportUrl(bookId,date,timezone));expect(response.status,await response.clone().text()).toBe(200);return DailyReportResponseSchema.parse(await response.json());}
async function reportText(h:Harness,bookId:string,date:string,timezone:string){const response=await h.request(reportUrl(bookId,date,timezone,true));expect(response.status,await response.clone().text()).toBe(200);return new JSDOM(await response.text()).window.document.body.textContent??'';}
async function generateReport(h:Harness,bookId:string,date:string,timezone:string,text:string){
  h.adapter.scripts.push(control=>{control.emit('text_delta',{text});control.emit('completed',{text,sessionReusable:true,toolResults:[]});control.end();});
  const response=await h.request(reportUrl(bookId,date,timezone),'POST');expect(response.status,await response.clone().text()).toBe(202);const {runId}=await response.json();const run=await terminalRun(h,runId);expect(run).toMatchObject({purpose:'daily',status:'completed',bookId,result:{advice:text,date,timezone,summaryIds:expect.any(Array)}});return run;
}

describe('independent repeatable daily reports and portable restore',()=>{
  it('two successful reports preserve history while JSON and HTML select the latest advice only for the requested book, date and timezone',async()=>{
    const h=await harness();const a=await importSynthetic(h,'报告甲书');const b=await importSynthetic(h,'报告乙书');confirmedRoot(h,a);confirmedRoot(h,b);
    const date=new Date().toISOString().slice(0,10);const firstText='甲书第一版合成建议';const latestText='甲书第二版合成建议 <仍需核对>';
    const first=await generateReport(h,a.id,date,'UTC',firstText);const second=await generateReport(h,a.id,date,'UTC',latestText);expect(second.id).not.toBe(first.id);
    const anotherBook=await generateReport(h,b.id,date,'UTC','乙书自己的合成建议');
    const anotherTimezone=await generateReport(h,a.id,date,'Asia/Shanghai','甲书上海时区的独立建议');
    const state=await h.state(a.id);const reportHistory=state.runs.filter(run=>run.purpose==='daily');expect(reportHistory).toHaveLength(3);
    expect(reportHistory.find(run=>run.id===first.id)?.result).toMatchObject({advice:firstText,date,timezone:'UTC'});
    expect(reportHistory.find(run=>run.id===second.id)?.result).toMatchObject({advice:latestText,date,timezone:'UTC'});
    const expectedSummaries=state.summaries.filter(summary=>summary.confirmed).map(summary=>summary.id).sort();
    expect((second.result as {summaryIds:string[]}).summaryIds.slice().sort()).toEqual(expectedSummaries);
    const main=await readReport(h,a.id,date,'UTC');expect(main).toMatchObject({book:{id:a.id},date,timezone:'UTC',advice:latestText});
    const html=await reportText(h,a.id,date,'UTC');expect(html).toContain(latestText);expect(html).not.toContain(firstText);expect(html).not.toContain('乙书自己的合成建议');expect(html).not.toContain('甲书上海时区的独立建议');
    expect((await readReport(h,b.id,date,'UTC')).advice).toBe((anotherBook.result as {advice:string}).advice);
    expect(await reportText(h,b.id,date,'UTC')).toContain('乙书自己的合成建议');expect(await reportText(h,b.id,date,'UTC')).not.toContain(latestText);
    expect((await readReport(h,a.id,date,'Asia/Shanghai')).advice).toBe((anotherTimezone.result as {advice:string}).advice);
    expect(await reportText(h,a.id,date,'Asia/Shanghai')).toContain('甲书上海时区的独立建议');expect(await reportText(h,a.id,date,'Asia/Shanghai')).not.toContain(latestText);
    const tomorrow=new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10);
    expect((await readReport(h,a.id,tomorrow,'UTC')).advice).not.toContain(latestText);expect(await reportText(h,a.id,tomorrow,'UTC')).not.toContain(latestText);
    expect(h.adapter.starts).toHaveLength(4);
  });

  it.each(['2026-02-30','2026-02-29','2026-04-31'])('rejects impossible calendar date %s in JSON, HTML and generation before starting AI',async(date)=>{
    const h=await harness();const book=await importSynthetic(h);confirmedRoot(h,book);const before=await h.state(book.id);
    for(const [method,html] of [['GET',false],['GET',true],['POST',false]] as const){
      const response=await h.request(reportUrl(book.id,date,'UTC',html),method);expect(response.status,await response.clone().text()).toBe(400);const error=ErrorResponseSchema.parse(await response.json());expect(error.error.code).toMatch(/DATE/);
    }
    expect(h.adapter.starts).toHaveLength(0);expect((await h.state(book.id)).runs).toEqual(before.runs);
  });

  it('portable restore interrupts active runs and makes every imported CLI session non-reusable',async()=>{
    const source=await harness();const book=await importSynthetic(source);const discussion=confirmedRoot(source,book);
    const firstResponse=await source.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'完成并留下合成会话'});expect(firstResponse.ok).toBe(true);const firstId=(await firstResponse.json()).runId;expect((await terminalRun(source,firstId)).sessionReusable).toBe(true);
    const sessionsBefore=source.store.list('sessions',book.id);expect(sessionsBefore.length).toBeGreaterThan(0);expect(sessionsBefore.some(session=>session.reusable)).toBe(true);
    source.adapter.scripts.push(control=>control.emit('text_delta',{text:'便携备份时仍在生成的合成片段'}));
    const runningResponse=await source.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'未完成的第二次运行'});expect(runningResponse.ok).toBe(true);const activeId=(await runningResponse.json()).runId;
    await waitFor(()=>source.state(book.id),state=>state.runs.some(run=>run.id===activeId&&run.status==='running'&&run.partialText.length>0),'active run persisted before portable backup');
    const created=await source.request('/api/backups','POST');expect(created.ok).toBe(true);const {id}=await created.json();const download=await source.request(`/api/backups/${id}`);expect(download.ok).toBe(true);const bytes=new Uint8Array(await download.arrayBuffer());
    const target=await harness();const restore=await target.upload('/api/restore',bytes,'portable-active-run.zip');expect(restore.ok,await restore.clone().text()).toBe(true);
    const restored=await target.state(book.id);expect(restored.runs.find(run=>run.id===activeId)).toMatchObject({status:'interrupted',sessionReusable:false,partialText:'便携备份时仍在生成的合成片段'});
    const restoredSessions=target.store.list('sessions',book.id);expect(restoredSessions.length).toBeGreaterThan(0);expect(restoredSessions.every(session=>session.reusable===false)).toBe(true);expect(target.adapter.starts).toHaveLength(0);
    const next=await target.request(`/api/discussions/${discussion.id}/messages`,'POST',{text:'在恢复后的产品继续'});expect(next.ok).toBe(true);const nextId=(await next.json()).runId;expect((await terminalRun(target,nextId)).status).toBe('completed');expect(target.adapter.starts[0].session).toEqual({mode:'new'});
  });
});
