import {afterEach,describe,expect,it} from 'vitest';
import {ControlledAdapter,importSynthetic,makeHarness,reference,waitFor} from '../contract/system-fixtures';
import type {Harness} from '../contract/system-fixtures';

const opened:Harness[]=[];
async function harness(adapter=new ControlledAdapter()){const value=await makeHarness(adapter);opened.push(value);return value;}
afterEach(async()=>{for(const value of opened.splice(0))await value.dispose();});

class ModelAdapter extends ControlledAdapter {
  async models(){return ['opencode-go/deepseek-v4-flash','zijie/doubao-x'];}
}
class InstalledClaudeAdapter extends ControlledAdapter {
  async probe(){return {installed:true,version:'2.0.0-test',authReported:true,invocationVerified:true,message:'Synthetic Claude adapter'};}
}
class SwitchableOpencodeAdapter extends ControlledAdapter {
  async probe(){return {installed:true,version:'1.0.0-test',authReported:true,invocationVerified:true,message:'Synthetic opencode adapter'};}
  async models(){return ['opencode-go/deepseek-v4-flash','zijie/doubao-x'];}
}

describe('runtime provider and model selection',()=>{
  it('reports the provider with an empty model list for adapters without model support',async()=>{
    const h=await harness();
    const response=await h.request('/api/runtime');
    expect(response.status).toBe(200);
    const body=await response.json();
    expect(body.provider).toBe('claude');
    expect(body.models).toEqual([]);
    expect(body.model).toBeNull();
  });

  it('persists a valid model selection across restart and passes it to runs',async()=>{
    const adapter=new ModelAdapter();const h=await harness(adapter);
    const rejected=await h.request('/api/runtime','PATCH',{model:'not-a-model'});expect(rejected.status).toBe(400);
    const saved=await h.request('/api/runtime','PATCH',{model:'zijie/doubao-x'});expect(saved.status).toBe(200);
    expect((await saved.json()).model).toBe('zijie/doubao-x');
    const changed=await h.request('/api/runtime','PATCH',{model:'opencode-go/deepseek-v4-flash'});expect(changed.status).toBe(200);
    expect((await changed.json()).model).toBe('opencode-go/deepseek-v4-flash');
    const book=await importSynthetic(h);
    const analysis=await h.request('/api/analyses','POST',{source:reference(book),question:'合成问题'});
    expect(analysis.status).toBe(202);
    expect(adapter.starts.at(-1)?.model).toBe('opencode-go/deepseek-v4-flash');
    await waitFor(()=>h.state(book.id),state=>state.runs.length===2&&state.runs.every(run=>['completed','failed'].includes(run.status)),'analysis chain complete');
    const reopened=await (async()=>{await h.dispose(false);opened.splice(opened.indexOf(h),1);const value=await makeHarness(new ModelAdapter(),h.dir);opened.push(value);return value;})();
    const body=await (await reopened.request('/api/runtime')).json();
    expect(body.model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('keeps model selections isolated per provider',async()=>{
    const h=await makeHarness(new ModelAdapter());opened.push(h);
    await h.request('/api/runtime','PATCH',{model:'zijie/doubao-x'});
    const dir=h.dir;await h.dispose(false);opened.splice(opened.indexOf(h),1);
    const asOpencode=await makeHarness(new ModelAdapter(),dir,'opencode');opened.push(asOpencode);
    expect((await (await asOpencode.request('/api/runtime')).json()).model).toBeNull();
    await asOpencode.request('/api/runtime','PATCH',{model:'opencode-go/deepseek-v4-flash'});
    await asOpencode.dispose(false);opened.splice(opened.indexOf(asOpencode),1);
    const backToClaude=await makeHarness(new ModelAdapter(),dir);opened.push(backToClaude);
    expect((await (await backToClaude.request('/api/runtime')).json()).model).toBe('zijie/doubao-x');
  });

  it('migrates a legacy shared model preference into the opencode scope',async()=>{
    const h=await harness();const dir=h.dir;
    h.store.setPreference('ai.model','opencode-go/deepseek-v4-flash');
    await h.dispose(false);opened.splice(opened.indexOf(h),1);
    const migrated=await makeHarness(new ModelAdapter(),dir,'opencode');opened.push(migrated);
    expect((await (await migrated.request('/api/runtime')).json()).model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('rejects model selection when the runtime has no models capability',async()=>{
    const h=await harness();
    const response=await h.request('/api/runtime','PATCH',{model:'any'});
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('MODEL_SELECTION_UNSUPPORTED');
  });

  it('skips original-source matching under opencode and answers the discussion directly',async()=>{
    const adapter=new ControlledAdapter();
    const h=await makeHarness(adapter,undefined,'opencode');opened.push(h);
    const book=await importSynthetic(h);
    const analysis=await h.request('/api/analyses','POST',{source:reference(book),question:'合成问题'});
    expect(analysis.status).toBe(202);
    const {discussionId}=await analysis.json();
    await waitFor(()=>h.state(book.id),state=>state.runs.length===1&&state.runs[0].status==='completed','direct discussion run complete');
    expect((await h.state(book.id)).runs.map(run=>run.purpose)).toEqual(['discussion']);
    const blocked=await h.request(`/api/discussions/${discussionId}/matching`,'POST');
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error.code).toBe('MATCHING_UNSUPPORTED');
    expect((await h.state(book.id)).runs).toHaveLength(1);
  });

  it('switches the AI provider at runtime and isolates its model preference',async()=>{
    const claude=new InstalledClaudeAdapter();const opencode=new SwitchableOpencodeAdapter();
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    const switched=await h.request('/api/runtime','PATCH',{provider:'opencode'});
    expect(switched.status).toBe(200);
    const body=await switched.json();
    expect(body.provider).toBe('opencode');
    expect(body.model).toBeNull();
    expect(body.models).toEqual(['opencode-go/deepseek-v4-flash','zijie/doubao-x']);
    const back=await h.request('/api/runtime','PATCH',{provider:'claude'});
    expect(back.status).toBe(200);
    expect((await back.json()).provider).toBe('claude');
  });

  it('routes new runs to the adapter selected at runtime',async()=>{
    const claude=new ControlledAdapter();const opencode=new SwitchableOpencodeAdapter();
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    await h.request('/api/runtime','PATCH',{provider:'opencode'});
    const book=await importSynthetic(h);
    const analysis=await h.request('/api/analyses','POST',{source:reference(book),question:'合成问题'});
    expect(analysis.status).toBe(202);
    await waitFor(()=>h.state(book.id),state=>state.runs.length===1&&state.runs[0].status==='completed','opencode discussion run complete');
    expect(opencode.starts).toHaveLength(1);
    expect(claude.starts).toHaveLength(0);
  });

  it('rejects provider switching while a run is active',async()=>{
    const claude=new ControlledAdapter();const opencode=new SwitchableOpencodeAdapter();
    claude.scripts.push(()=>{});
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    const book=await importSynthetic(h);
    const analysis=await h.request('/api/analyses','POST',{source:reference(book),question:'合成问题'});
    expect(analysis.status).toBe(202);
    await waitFor(()=>h.state(book.id),state=>state.runs.some(run=>run.status==='running'),'matching run active');
    const switched=await h.request('/api/runtime','PATCH',{provider:'opencode'});
    expect(switched.status).toBe(409);
    expect((await switched.json()).error.code).toBe('RUNTIME_BUSY');
  });

  it('rejects switching to a provider without an adapter',async()=>{
    const h=await harness();
    const response=await h.request('/api/runtime','PATCH',{provider:'opencode'});
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('rejects switching to a runtime that is not installed',async()=>{
    const claude=new ControlledAdapter();const opencode=new ControlledAdapter();
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    const response=await h.request('/api/runtime','PATCH',{provider:'opencode'});
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('PROVIDER_NOT_INSTALLED');
  });

  it('persists the selected provider across restart, ahead of the configured default',async()=>{
    const claude=new ControlledAdapter();const opencode=new SwitchableOpencodeAdapter();
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    await h.request('/api/runtime','PATCH',{provider:'opencode'});
    const dir=h.dir;await h.dispose(false);opened.splice(opened.indexOf(h),1);
    const reopened=await makeHarness(claude,dir,'claude',p=>p==='opencode'?opencode:claude);opened.push(reopened);
    const body=await (await reopened.request('/api/runtime')).json();
    expect(body.provider).toBe('opencode');
  });

  it('applies provider and model in one request, validating against the new runtime',async()=>{
    const claude=new InstalledClaudeAdapter();const opencode=new SwitchableOpencodeAdapter();
    const h=await makeHarness(claude,undefined,'claude',p=>p==='opencode'?opencode:claude);opened.push(h);
    const ok=await h.request('/api/runtime','PATCH',{provider:'opencode',model:'zijie/doubao-x'});
    expect(ok.status).toBe(200);
    const body=await ok.json();
    expect(body.provider).toBe('opencode');
    expect(body.model).toBe('zijie/doubao-x');
    const rejected=await h.request('/api/runtime','PATCH',{provider:'claude',model:'zijie/doubao-x'});
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe('MODEL_SELECTION_UNSUPPORTED');
  });
});
