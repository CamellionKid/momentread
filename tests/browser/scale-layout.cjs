// Run with `node tests/browser/scale-layout.cjs` and the repository dependency.
// Chrome gets a fresh temporary
// Playwright profile; this script never connects to the user's normal profile.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const TARGET_URL=process.env.MOMENTREAD_SCALE_URL||'http://127.0.0.1:4325';
const MANIFEST_PATH=process.env.MOMENTREAD_SCALE_MANIFEST||'/tmp/momentread-browser-scale-manifest.json';
const OUTPUT_DIR=process.env.MOMENTREAD_SCALE_OUTPUT||'/tmp/momentread-browser-scale-results';
const viewports=[{width:1487,height:1058},{width:1280,height:720},{width:390,height:844}];
const manifest=JSON.parse(fs.readFileSync(MANIFEST_PATH,'utf8'));
const results={synthetic:true,realModelInvocations:0,url:TARGET_URL,discussionCount:500,pathLength:20,startedAt:new Date().toISOString(),checks:[],screenshots:[],pageErrors:[],outboundRequests:[]};
fs.mkdirSync(OUTPUT_DIR,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,predicate,label){let last;const until=Date.now()+10000;while(Date.now()<until){last=await fn();if(predicate(last))return last;await sleep(40);}throw new Error(`${label}: timed out; last=${JSON.stringify(last)}`);}
async function state(page){const response=await page.request.get(`${TARGET_URL}/api/books/${manifest.bookId}/state`);assert.equal(response.status(),200);return response.json();}
async function within(locator,viewport){const rect=await locator.boundingBox();assert.ok(rect&&rect.width>0&&rect.height>0,'visible nonzero element');assert.ok(rect.x>=-1&&rect.y>=-1&&rect.x+rect.width<=viewport.width+1&&rect.y+rect.height<=viewport.height+1,`outside viewport: ${JSON.stringify(rect)}`);return rect;}

(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:false});
 results.browserVersion=await browser.version();
 try {
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',error=>results.pageErrors.push(error.message));
  page.on('request',request=>{const url=request.url();if(/^https?:/.test(url)&&!url.startsWith(TARGET_URL))results.outboundRequests.push(url);});
  async function screenshot(name){const file=path.join(OUTPUT_DIR,`${name}.png`);await page.screenshot({path:file});results.screenshots.push(file);return file;}
  async function check(name,fn){const began=Date.now();try{const detail=await fn();results.checks.push({name,status:'passed',durationMs:Date.now()-began,detail});console.log('PASS',name,JSON.stringify(detail??{}));return true;}catch(error){results.checks.push({name,status:'failed',durationMs:Date.now()-began,error:error.message});console.error('FAIL',name,error.message);await screenshot(`failure-${results.checks.length}`);await page.keyboard.press('Escape');return false;}finally{fs.writeFileSync(path.join(OUTPUT_DIR,'results.json'),JSON.stringify(results,null,2));}}
  for(const viewport of viewports){
   const label=`${viewport.width}x${viewport.height}`;
   await page.setViewportSize(viewport);
   // Public HTTP fixture setup: normalize workspace state before testing UI.
   const arranged=await page.request.patch(`${TARGET_URL}/api/books/${manifest.bookId}/workspace`,{data:{activeDiscussionId:manifest.deepestId,collapsed:[],fontSize:22}});assert.equal(arranged.status(),200);
   await page.goto(TARGET_URL,{waitUntil:'networkidle'});
   // Always enter through the shelf action. The same book title also appears in
   // the reader header, where it intentionally opens the metadata dialog.
   await page.getByRole('button',{name:'MomentRead 书架',exact:true}).click();
   await page.getByRole('button',{name:'打开阅读',exact:true}).click();
   if(viewport.width<800){await screenshot(`${label}-reading`);await page.getByRole('button',{name:/^AI 讨论/}).click();}
   await page.getByRole('textbox',{name:'继续提问'}).waitFor();
   const rail=page.getByRole('complementary',{name:'概念线路图'});
   await check(`${label} panels and input remain inside the viewport`,async()=>{
    const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight}));
    assert.ok(dimensions.scrollWidth<=dimensions.width+1);assert.ok(dimensions.scrollHeight<=dimensions.height+1);
    const input=await within(page.getByRole('textbox',{name:'继续提问'}),viewport);const panel=await within(page.getByRole('region',{name:'AI 讨论',exact:true}),viewport);const route=await within(rail,viewport);
    if(viewport.width>=800)await within(page.getByRole('region',{name:'正文',exact:true}),viewport);
    return {dimensions,input,panel,route};
   });
   await check(`${label} 500 nodes use full-size scrollable layout`,async()=>{
    await poll(()=>rail.locator('button[aria-label]').count(),count=>count===500,'all graph nodes');
    const metrics=await rail.evaluate(element=>{const nodes=[...element.querySelectorAll('button[aria-label]')];return {count:nodes.length,clientWidth:element.clientWidth,clientHeight:element.clientHeight,scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,minNodeWidth:Math.min(...nodes.map(node=>node.getBoundingClientRect().width)),minNodeHeight:Math.min(...nodes.map(node=>node.getBoundingClientRect().height)),visibleLabels:nodes.filter(node=>node.textContent.trim()).length};});
    assert.equal(metrics.count,500);assert.ok(metrics.minNodeWidth>=16&&metrics.minNodeHeight>=16,'nodes must not shrink to fit all 500');assert.ok(metrics.scrollHeight>metrics.clientHeight*10);assert.ok(metrics.scrollWidth>metrics.clientWidth);assert.equal(metrics.visibleLabels,0);return metrics;
   });
   await screenshot(`${label}-discussion`);
   await check(`${label} complete ancestor dialog exposes all 20 levels`,async()=>{
    await page.getByRole('button',{name:'查看完整祖先路径'}).click();const dialog=page.getByRole('dialog',{name:'当前讨论的完整路径'});await dialog.waitFor();const rect=await within(dialog,viewport);
    const items=await dialog.locator('button').allTextContents();const pathItems=items.map(text=>text.trim()).filter(text=>/^\d/.test(text));assert.equal(pathItems.length,20);
    manifest.path.forEach((node,index)=>assert.ok(pathItems[index].includes(node.title),`missing level ${index+1}`));
    await screenshot(`${label}-path-dialog`);const last=dialog.getByRole('button').filter({hasText:manifest.path[19].title});await last.scrollIntoViewIfNeeded();await within(last,viewport);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});return {pathItems,rect};
   });
   await check(`${label} branch folding preserves the active path and expands back to 500`,async()=>{
    await page.getByRole('button',{name:'讨论操作',exact:true}).click();await page.getByRole('button',{name:'折叠其他分支',exact:true}).click();
    const folded=await poll(()=>rail.locator('button[aria-label]').count(),count=>count===44,'folded tree count');
    const after=await state(page);assert.equal(after.workspace.activeDiscussionId,manifest.deepestId);assert.equal(after.discussions.length,500);
    for(const node of manifest.path)assert.equal(await rail.getByRole('button',{name:node.title,exact:true}).count(),1);
    await screenshot(`${label}-folded`);await page.getByRole('button',{name:'讨论操作',exact:true}).click();await page.getByRole('button',{name:'展开全部分支',exact:true}).click();await poll(()=>rail.locator('button[aria-label]').count(),count=>count===500,'expanded tree count');return {folded,expanded:500};
   });
   await check(`${label} switching sibling nodes preserves independent drafts`,async()=>{
    const start=Date.now();await rail.getByRole('button',{name:'同级 001 · 合成规模验收概念',exact:true}).click();const input=page.getByRole('textbox',{name:'继续提问'});await poll(()=>input.inputValue(),value=>value.includes('同级 1')||value.startsWith('规模浏览器草稿'),'first sibling input');
    const draft=`规模浏览器草稿 ${label}：只属于同级 001。`;await input.fill(draft);await poll(()=>state(page),value=>value.discussions.find(d=>d.id===manifest.siblingIds[0])?.draft===draft,'draft persisted');
    await rail.getByRole('button',{name:'同级 002 · 合成规模验收概念',exact:true}).click();await poll(()=>input.inputValue(),value=>value==='同级 2 的独立合成草稿','second sibling input');
    await rail.getByRole('button',{name:'同级 001 · 合成规模验收概念',exact:true}).click();await poll(()=>input.inputValue(),value=>value===draft,'restored first sibling draft');
    await rail.getByRole('button',{name:manifest.path[19].title,exact:true}).click();await poll(()=>input.inputValue(),value=>value.includes('深度 20'),'return to deepest input');return {durationMs:Date.now()-start,savedDraft:draft};
   });
   await check(`${label} long discussion scrolls independently and Markdown stays contained`,async()=>{
    const scroll=page.locator('.discussion-scroll');const bounds=await scroll.boundingBox();assert.ok(bounds);const initial=await scroll.evaluate(e=>({scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}));assert.ok(initial.scrollHeight>initial.clientHeight);
    await scroll.hover();await page.mouse.wheel(0,600);await poll(()=>scroll.evaluate(e=>e.scrollTop),top=>top>initial.scrollTop,'discussion wheel scroll');await within(page.getByRole('textbox',{name:'继续提问'}),viewport);
    assert.ok(await scroll.locator('h2').count());assert.ok(await scroll.locator('table').count());
    const pre=scroll.locator('pre');assert.ok(await pre.count());const codeMetrics=await pre.first().evaluate(e=>({clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,overflow:getComputedStyle(e).overflowX}));assert.ok(codeMetrics.scrollWidth>=codeMetrics.clientWidth);assert.equal(codeMetrics.overflow,'auto');
    assert.equal(await page.evaluate(()=>window.scrollY),0);return {initial,codeMetrics};
   });
  }
  // Exercise the editor after navigation checks so an intentionally unconfirmed
  // summary does not introduce a pending-summary dialog into later scenarios.
  await page.getByRole('button',{name:'整理并返回',exact:true}).click();const summaryDialog=page.getByRole('dialog',{name:'整理并返回'});await summaryDialog.waitFor();await summaryDialog.locator('textarea').waitFor();
  for(const viewport of viewports){await page.setViewportSize(viewport);const label=`${viewport.width}x${viewport.height}`;
   await check(`${label} editable summary dialog and its controls are reachable`,async()=>{
    const rect=await within(summaryDialog,viewport);const editor=summaryDialog.locator('textarea');await editor.fill('合成布局核对：本次不确认、不向父讨论回馈。');await within(editor,viewport);
    const controls=await summaryDialog.locator('button').allTextContents();await screenshot(`${label}-summary-dialog`);return {rect,controls};
   });
  }
  await page.keyboard.press('Escape');await summaryDialog.waitFor({state:'detached'});
  assert.deepEqual(results.pageErrors,[]);assert.deepEqual(results.outboundRequests,[]);
 } catch(error){results.fatalError=error.message;console.error(error);} finally {await browser.close();results.finishedAt=new Date().toISOString();results.passed=results.checks.filter(item=>item.status==='passed').length;results.failed=results.checks.filter(item=>item.status==='failed').length;fs.writeFileSync(path.join(OUTPUT_DIR,'results.json'),JSON.stringify(results,null,2));console.log('RESULT',JSON.stringify({passed:results.passed,failed:results.failed,fatalError:results.fatalError,output:OUTPUT_DIR}));if(results.failed||results.fatalError)process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
