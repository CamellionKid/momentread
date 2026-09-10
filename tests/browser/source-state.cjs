const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const TARGET_URL=process.env.MOMENTREAD_SCALE_URL||'http://127.0.0.1:4325';
const manifest=JSON.parse(fs.readFileSync(process.env.MOMENTREAD_SCALE_MANIFEST||'/tmp/momentread-browser-scale-manifest.json','utf8'));
const OUTPUT_DIR=process.env.MOMENTREAD_SCALE_OUTPUT||'/tmp/momentread-browser-scale-results';
fs.mkdirSync(OUTPUT_DIR,{recursive:true});
const result={synthetic:true,realNetworkRetrievals:0,realModelInvocations:0,startedAt:new Date().toISOString(),checks:[],requests:[],screenshots:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,predicate,label){let value;const until=Date.now()+8000;while(Date.now()<until){value=await fn();if(predicate(value))return value;await sleep(40);}throw new Error(`${label} timed out: ${JSON.stringify(value)}`);}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:false});try{
 const page=await browser.newPage({viewport:{width:1487,height:1058}});page.setDefaultTimeout(10000);
 // Reset only the two clearly synthetic candidate records so this UI scenario
 // is repeatable after its separate explicit-confirmation action.
 for(const id of Object.values(manifest.sourceIds)){const reset=await page.request.patch(`${TARGET_URL}/api/sources/${id}`,{data:{selected:false,verification:'unverified'}});assert.equal(reset.status(),200);}
 page.on('request',request=>{if(request.method()==='PATCH'&&request.url().includes('/api/sources/'))result.requests.push({url:request.url(),body:request.postDataJSON()});});
 const state=async()=>{const response=await page.request.get(`${TARGET_URL}/api/books/${manifest.bookId}/state`);assert.equal(response.status(),200);return response.json();};
 const before=await state();const aBefore=before.sources.find(source=>source.id===manifest.sourceIds.retrieved);const bBefore=before.sources.find(source=>source.id===manifest.sourceIds.unavailable);
 assert.equal(aBefore.retrieval,'retrieved');assert.equal(aBefore.verification,'unverified');assert.equal(aBefore.selected,false);assert.equal(bBefore.retrieval,'unavailable');assert.equal(bBefore.verification,'unverified');
 await page.goto(TARGET_URL,{waitUntil:'networkidle'});await page.getByText('合成规模验收 · 500 讨论 · 20 层 · 模型未运行',{exact:true}).click();await page.getByRole('textbox',{name:'继续提问'}).waitFor();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:/原著候选待核对/}).click();const dialog=page.getByRole('dialog',{name:'原著依据与核对'});await dialog.waitFor();
 const retrieved=dialog.locator('article').filter({hasText:'合成候选 A · retrieved 状态 fixture'});const unavailable=dialog.locator('article').filter({hasText:'合成候选 B · unavailable 状态 fixture'});
 assert.equal(await retrieved.count(),1);assert.equal(await unavailable.count(),1);assert.ok((await retrieved.innerText()).includes('待核对'));assert.ok((await unavailable.innerText()).includes('没有可引用的原著文本'));
 assert.equal(await unavailable.getByRole('button',{name:'我已对照确认'}).isDisabled(),true);assert.equal(await unavailable.getByRole('button',{name:'选作候选'}).isDisabled(),true);
 result.checks.push({name:'unavailable synthetic candidate cannot be selected or confirmed',status:'passed'});
 const shot=async(name)=>{const file=path.join(OUTPUT_DIR,`${name}.png`);await page.screenshot({path:file});result.screenshots.push(file);};await shot('sources-unselected');
 await retrieved.getByRole('button',{name:'选作候选'}).click();const selected=await poll(state,value=>value.sources.find(source=>source.id===manifest.sourceIds.retrieved)?.selected===true,'candidate selected');
 const selectedSource=selected.sources.find(source=>source.id===manifest.sourceIds.retrieved);assert.equal(selectedSource.verification,'unverified');
 const selectedText=await retrieved.innerText();assert.match(selectedText,/待核对/);assert.doesNotMatch(selectedText,/已确认/);result.checks.push({name:'selecting a retrieved synthetic candidate keeps it unverified',status:'passed',cardText:selectedText,state:{selected:selectedSource.selected,verification:selectedSource.verification}});await shot('sources-selected-still-unverified');
 await retrieved.getByRole('button',{name:'我已对照确认'}).click();const confirmed=await poll(state,value=>value.sources.find(source=>source.id===manifest.sourceIds.retrieved)?.verification==='confirmed','separate explicit confirmation');
 const confirmedSource=confirmed.sources.find(source=>source.id===manifest.sourceIds.retrieved);assert.equal(confirmedSource.selected,true);const failedSource=confirmed.sources.find(source=>source.id===manifest.sourceIds.unavailable);assert.equal(failedSource.verification,'unverified');assert.equal(failedSource.selected,false);
 result.checks.push({name:'only an explicit second action confirms the selected synthetic candidate',status:'passed',state:{selected:confirmedSource.selected,verification:confirmedSource.verification}});await shot('sources-explicitly-confirmed');
 assert.equal(result.requests.length,2);assert.equal(result.requests[0].body.selected,true);assert.notEqual(result.requests[0].body.verification,'confirmed');assert.equal(result.requests[1].body.verification,'confirmed');
 result.checks.push({name:'selection and verification use separate public API mutations',status:'passed'});
 }catch(error){result.error=error.message;console.error(error);process.exitCode=1;}finally{await browser.close();result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(OUTPUT_DIR,'source-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.checks.length,error:result.error,output:OUTPUT_DIR}));}})();
