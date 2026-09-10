import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {seedScale} from './seed-scale';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
const usage=`From the repository, after the intended build has completed:
  npx tsx tests/browser/run-scale.ts --port 4325 --output /tmp/momentread-scale-evidence

Options:
  --port <number>   Independent loopback port (default 4325; 4317 is forbidden).
  --output <path>   New evidence directory; existing paths are never overwritten.
  --prepare-only   Seed and snapshot only; do not start the service or browser.
  --help           Print this help.

Uses repository dependencies and installed Google Chrome with temporary profiles.
Creates a fresh synthetic data directory; never invokes the real model or builds.
Preserves data and evidence, and stops only the service started by this command.`;

async function fingerprints(directory:string):Promise<{file:string;sha256:string;bytes:number}[]>{
  const entries=await readdir(directory,{withFileTypes:true});
  const result:{file:string;sha256:string;bytes:number}[]=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    const filename=join(directory,entry.name);
    if(entry.isDirectory())result.push(...await fingerprints(filename));
    else if(entry.isFile()){const bytes=await readFile(filename);result.push({file:filename,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
  }
  return result;
}

async function requireFreePort(port:number){
  await new Promise<void>((done,reject)=>{
    const probe=createServer();probe.once('error',reject);
    probe.listen(port,'127.0.0.1',()=>probe.close(error=>error?reject(error):done()));
  });
}

async function stopOwnedServer(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(done=>{
    const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.once('exit',()=>{clearTimeout(timeout);done();});
    child.kill('SIGTERM');
  });
}

async function main(){
  let port=4325;let output:string|undefined;let prepareOnly=false;
  const args=process.argv.slice(2);
  for(let index=0;index<args.length;index++){
    const flag=args[index];
    if(flag==='--help'){console.log(usage);return;}
    if(flag==='--prepare-only'){prepareOnly=true;continue;}
    if(flag==='--port'||flag==='--output'){
      const value=args[++index];if(!value||value.startsWith('--'))throw new Error(`${flag} requires a value`);
      if(flag==='--port')port=Number(value);else output=resolve(value);
    }else throw new Error(`Unknown argument: ${flag}`);
  }
  if(!Number.isInteger(port)||port<1024||port>65535||port===4317)throw new Error('Use an independent port from 1024 to 65535, excluding 4317.');
  const playwrightVersion=require('playwright/package.json').version as string;
  const sourceClient=join(repo,'dist/client');
  await readFile(join(sourceClient,'index.html')); // Fail before seeding if there is no completed client build.
  if(!prepareOnly)await requireFreePort(port);
  if(output){await mkdir(dirname(output),{recursive:true});await mkdir(output);}
  const manifest=await seedScale();
  const candidate=join(manifest.dataDir,'candidate');
  const client=join(candidate,'dist/client');
  output??=join(manifest.dataDir,'evidence');
  await mkdir(output,{recursive:true});await mkdir(dirname(client),{recursive:true});
  await cp(sourceClient,client,{recursive:true,errorOnExist:true,force:false});
  const assets=(await fingerprints(client)).map(asset=>({...asset,file:relative(client,asset.file)}));
  const manifestPath=join(output,'seed-manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  const record={synthetic:true,realModelInvocations:0,startedAt:new Date().toISOString(),finishedAt:null as string|null,repo,dataDir:manifest.dataDir,output,clientSnapshot:client,clientFiles:assets,node:process.version,playwright:playwrightVersion,url:`http://127.0.0.1:${port}`,prepareOnly,status:'prepared',suites:[] as {script:string;exitCode:number|null;signal:NodeJS.Signals|null}[],error:null as string|null};
  const save=()=>writeFile(join(output!,'artifact-manifest.json'),JSON.stringify(record,null,2));
  await save();console.log(JSON.stringify({dataDir:manifest.dataDir,manifest:manifestPath,output,url:record.url,prepareOnly}));
  if(prepareOnly)return;
  const serverLog=createWriteStream(join(output,'server.log'),{flags:'wx'});
  // A direct Node loader keeps the HTTP server in the process we own and stop.
  const server=spawn(process.execPath,['--import',require.resolve('tsx'),join(repo,'tests/browser/scale-server.ts'),manifest.dataDir,String(port)],{cwd:candidate,stdio:['ignore','pipe','pipe']});
  server.stdout?.pipe(serverLog);server.stderr?.pipe(serverLog);
  let serverError:Error|undefined;server.once('error',error=>{serverError=error;});
  const onSignal=()=>{void stopOwnedServer(server);};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try {
    let ready=false;const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if(serverError)throw serverError;
      if(server.exitCode!==null||server.signalCode!==null)throw new Error(`Synthetic server exited before readiness; see ${join(output,'server.log')}`);
      try {
        const health=await fetch(`${record.url}/api/health`,{signal:AbortSignal.timeout(1000)});
        const root=await fetch(record.url,{signal:AbortSignal.timeout(1000)});
        if(health.status===200&&root.status===200&&(await root.text()).includes('<html')){ready=true;break;}
      }catch{ /* Retry only this owned local server while it starts. */ }
      await new Promise(done=>setTimeout(done,100));
    }
    if(!ready)throw new Error(`Synthetic server readiness timed out; see ${join(output,'server.log')}`);
    const env={...process.env,MOMENTREAD_SCALE_URL:record.url,MOMENTREAD_SCALE_MANIFEST:manifestPath,MOMENTREAD_SCALE_OUTPUT:output};
    for(const script of ['scale-layout.cjs','source-state.cjs','report-date.cjs']){
      const result=await new Promise<{script:string;exitCode:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{
        const runner=spawn(process.execPath,[join(repo,'tests/browser',script)],{cwd:repo,env,stdio:'inherit'});
        runner.once('error',reject);runner.once('exit',(exitCode,signal)=>done({script,exitCode,signal}));
      });
      record.suites.push(result);await save();
    }
    record.status=record.suites.every(suite=>suite.exitCode===0)?'passed':'failed';
    if(record.status==='failed')process.exitCode=1;
  }catch(error){record.status='failed';record.error=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(record.error);}
  finally {
    await stopOwnedServer(server);serverLog.end();
    process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
    record.finishedAt=new Date().toISOString();await save();
  }
  console.log(JSON.stringify({status:record.status,output,dataDir:manifest.dataDir,suites:record.suites}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
