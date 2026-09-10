import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {createApp} from '../../server/app';
import {createStore} from '../../server/storage';
import {createBookLibrary} from '../../server/books';
import {createLearningService} from '../../server/learning';
import {createMatchingService} from '../../server/matching';
import {ControlledAdapter} from '../contract/system-fixtures';
import type {StartRun} from '../../shared/contracts/ports';
import {syntheticMarkdown} from './seed-scale';

class SyntheticBrowserAdapter extends ControlledAdapter {
  override async start(request:StartRun){
    this.scripts.push(control=>{
      if(request.purpose==='matching')control.emit('failed',{code:'SYNTHETIC_ONLY',message:'合成浏览器验收不运行检索或真实模型。',sessionReusable:false});
      else if(request.purpose==='summary')control.emit('completed',{text:'合成小结',structuredOutput:{content:'## 合成小结\n\n本次仅检查对话框与编辑保存。\n\n- 模型未运行。\n- 真实解释仍需单独验证。'},sessionReusable:false,toolResults:[]});
      else {control.emit('text_delta',{text:syntheticMarkdown});control.emit('completed',{text:syntheticMarkdown,sessionReusable:false,toolResults:[]});}
      control.end();
    });
    return super.start(request);
  }
}

const dataDir=process.argv[2];const port=Number(process.argv[3]??4325);
if(!dataDir||!Number.isInteger(port)||port===4317)throw new Error('Supply an independent data directory and a non-production port.');
const store=createStore(dataDir);const library=createBookLibrary(store,dataDir);const learning=createLearningService(store);const matching=createMatchingService(store,library);const adapter=new SyntheticBrowserAdapter();
const {app}=createApp({store,library,learning,matching,adapter,port});
// The test process serves an immutable copy of the built client from its cwd.
app.use('/*',serveStatic({root:'./dist/client'}));
app.get('*',serveStatic({path:'./dist/client/index.html'}));
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port},()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,dataDir,synthetic:true,realModelInvocations:0})));
const shutdown=()=>server.close(()=>{store.close();process.exit(0);});process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
