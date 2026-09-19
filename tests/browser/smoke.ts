import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {chromium,type Browser} from 'playwright';
import {createApp} from '../../server/app';
import {createStore} from '../../server/storage';
import {createBookLibrary} from '../../server/books';
import {createLearningService} from '../../server/learning';
import {createMatchingService} from '../../server/matching';
import {ControlledAdapter,syntheticEpub,waitFor} from '../contract/system-fixtures';
import {APP_VERSION} from '../../shared/version';
import type {Renderer} from '../../src/reader/foliate-types';

// Built UI + real HTTP/SQLite/EPUB reader. Only model execution is synthetic.
const dir=await mkdtemp(join(tmpdir(),'momentread-smoke-'));
const output=resolve('test-results');await mkdir(output,{recursive:true});
const store=createStore(dir);const library=createBookLibrary(store,dir);
const adapter=new ControlledAdapter();const timers:ReturnType<typeof setTimeout>[]=[];
const server=serve({fetch:request=>app.fetch(request),hostname:'127.0.0.1',port:0});
await once(server,'listening');
const port=(server.address() as {port:number}).port;
const {app,runs}=createApp({store,library,adapter,learning:createLearningService(store),matching:createMatchingService(store,library),port,ai:{provider:'opencode'}});
app.use('/*',serveStatic({root:resolve('dist/client')}));
app.get('*',serveStatic({path:resolve('dist/client/index.html')}));
const url=`http://127.0.0.1:${port}`;
const report={synthetic:true,realModelInvocations:0,version:APP_VERSION,checks:[] as string[],errors:[] as string[],maximumPollingStateRequests:0,status:'running'};
let browser:Browser|undefined;
try {
  browser=await chromium.launch({headless:true,...(process.env.MOMENTREAD_BROWSER_CHANNEL?{channel:process.env.MOMENTREAD_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.errors.push(error.message));
  try {
    await page.goto(url);
    const readerReady=()=>page.waitForFunction(()=>{const renderer=document.querySelector('foliate-paginator') as Renderer|null;return (renderer?.getContents()[0]?.doc.querySelector('#repeat')?.getBoundingClientRect().height??0)>0;});
    const importBook=async(title:string)=>{
      await page.getByRole('button',{name:'导入 EPUB',exact:true}).first().click();
      await page.getByLabel('选择文件').setInputFiles({name:`${title}.epub`,mimeType:'application/epub+zip',buffer:Buffer.from(syntheticEpub(title))});
      await page.getByRole('button',{name:'导入并打开'}).click();
      await page.getByRole('button',{name:'书籍资料'}).filter({hasText:title}).waitFor();
      await readerReady();
    };
    await importBook('合成冒烟甲书');report.checks.push('import EPUB and render actual chapter');
    const bookA=store.list('books')[0];
    const inFlight=new Map<string,number>();
    let measuringPolling=true;
    await page.route('**/api/books/*/state',async route=>{
      const key=route.request().url();const count=(inFlight.get(key)??0)+1;inFlight.set(key,count);
      if(measuringPolling)report.maximumPollingStateRequests=Math.max(report.maximumPollingStateRequests,count);
      try {
        const response=await route.fetch();
        await new Promise(done=>setTimeout(done,1200));
        await route.fulfill({response});
      } finally {inFlight.set(key,(inFlight.get(key)??1)-1);}
    });
    adapter.scripts.push(control=>{
      control.emit('text_delta',{text:'冒烟阶段一'});
      timers.push(setTimeout(()=>control.emit('text_delta',{text:'，阶段二'}),2500));
      timers.push(setTimeout(()=>{control.emit('completed',{text:'冒烟最终答案',sessionReusable:false});control.end();},6000));
    });
    await page.evaluate(()=>{
      const renderer=document.querySelector('foliate-paginator') as Renderer;const doc=renderer.getContents()[0].doc;const element=doc.querySelector('#repeat')!;const selection=doc.getSelection()!;const range=doc.createRange();range.selectNodeContents(element);selection.removeAllRanges();selection.addRange(range);doc.dispatchEvent(new Event('mouseup'));
    });
    await page.getByRole('button',{name:'解析一下',exact:true}).click();
    await page.getByText('冒烟阶段一',{exact:true}).waitFor();
    await page.getByText('冒烟阶段一，阶段二',{exact:true}).waitFor();
    await page.getByText('冒烟最终答案',{exact:true}).waitFor();
    await page.getByRole('button',{name:'停止生成'}).waitFor({state:'hidden'});
    assert.equal(report.maximumPollingStateRequests,1);measuringPolling=false;
    report.checks.push('1200 ms state responses update partial text and terminal state with one request per book');
    adapter.scripts.push(control=>control.emit('text_delta',{text:'等待取消的合成片段'}));
    await page.getByRole('textbox',{name:'继续提问'}).fill('取消冒烟');
    await page.getByRole('button',{name:'发送问题'}).click();
    await page.getByRole('button',{name:'停止生成'}).click();
    await page.getByText('已停止生成',{exact:true}).waitFor();
    assert.equal(store.list('runs').at(-1)?.status,'cancelled');
    assert.equal(adapter.starts.length,2);report.checks.push('cancel retains partial text and does not start another run');
    await page.getByRole('textbox',{name:'继续提问'}).fill('刷新后保留的合成草稿');
    await waitFor(async()=>store.list('discussions')[0]?.draft,value=>value==='刷新后保留的合成草稿','draft saved');
    await page.reload();
    await page.getByRole('textbox',{name:'继续提问'}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'继续提问'}).inputValue(),'刷新后保留的合成草稿');
    assert.equal(adapter.starts.length,2);report.checks.push('refresh restores saved draft and cancelled state without model invocation');
    await page.getByRole('button',{name:'MomentRead 书架'}).click();
    await page.locator('foliate-paginator').waitFor({state:'detached'});
    await importBook('合成冒烟乙书');report.checks.push('unmount reader and import a second book');
    for(const title of ['合成冒烟甲书','合成冒烟乙书','合成冒烟甲书']){
      await page.getByRole('button',{name:'MomentRead 书架'}).click();
      await page.getByRole('button',{name:title,exact:true}).click();
      await page.getByRole('button',{name:'书籍资料'}).filter({hasText:title}).waitFor();
      await readerReady();
    }
    assert.equal(store.list('books').length,2);assert.equal(store.list('discussions',bookA.id).length,1);
    report.checks.push('switch and reopen books without state mixing or reader errors');
    await page.getByRole('button',{name:'AI 连接与数据'}).click();
    await page.getByText(`MomentRead ${APP_VERSION}`,{exact:true}).waitFor();
    assert.equal((await (await page.request.get(`${url}/api/health`)).json()).version,APP_VERSION);
    report.checks.push('UI and health report the package version');
    assert.deepEqual(report.errors,[]);report.checks.push('zero browser page errors');report.status='passed';
  }catch(error){await page.screenshot({path:join(output,'smoke-failure.png')});throw error;}
} catch(error) {report.status='failed';report.errors.push(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally {
  timers.forEach(clearTimeout);await runs.shutdown();await browser?.close();
  await new Promise<void>(done=>{server.close(()=>done());if('closeAllConnections' in server)server.closeAllConnections();});
  store.close();await rm(dir,{recursive:true,force:true});
  await writeFile(join(output,'smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
