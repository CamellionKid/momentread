import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createStore} from '../../server/storage';
import {createBookLibrary} from '../../server/books';
import {createLearningService} from '../../server/learning';
import {syntheticEpub, reference} from '../contract/system-fixtures';
import type {Discussion} from '../../shared/contracts';

export const syntheticMarkdown=`**合成概念** — 本回答是浏览器规模验收的合成记录，模型未运行。

## 这段在说什么

这是一条用于检验换行、阅读和节点切换的合成说明。相同术语在不同节点中保持独立语境。

- 观察当前位置和直接父节点。
- 在窄屏确认输入区与操作仍能到达。
- 切换节点后保留各自草稿。

| 检查项 | 合成结论 |
| --- | --- |
| 来源 | 程序生成的合成 EPUB |
| 模型 | 未运行 Claude，仅有合成记录 |

\`\`\`text
synthetic_long_token_for_horizontal_scrolling_${'segment_'.repeat(24)}
\`\`\`

${Array.from({length:14},(_,index)=>`第 ${index+1} 段合成解释：用足够长的内容检验独立滚动、Markdown段落和返还到原思路的导航。这里只证明布局与保存记录可访问，不证明学习质量。`).join('\n\n')}`;

export async function seedScale(dataDir?:string){
  const directory=dataDir?resolve(dataDir):await mkdtemp(join(tmpdir(),'momentread-browser-scale-'));
  const store=createStore(directory);const library=createBookLibrary(store,directory);const learning=createLearningService(store);
  try {
    if(store.list('books').length)throw new Error('Scale seeding requires an empty independent data directory.');
    const book=await library.importBook(syntheticEpub('合成规模验收 · 500 讨论 · 20 层 · 模型未运行'),'synthetic-browser-scale.epub');
    const root=learning.createRoot({source:reference(book),question:'这是浏览器规模验收的合成根讨论；请勿作为模型质量证据。'});
    function addSyntheticAnswer(discussion:Discussion){
      const context=learning.buildInput(discussion.id,'discussion');const id=randomUUID();const createdAt=new Date().toISOString();
      store.put('runs',{id,bookId:book.id,discussionId:discussion.id,purpose:'discussion',status:'completed',contextSnapshotId:context.id,sessionId:null,sessionReusable:false,partialText:syntheticMarkdown,result:{kind:'synthetic-browser-scale',text:syntheticMarkdown},error:null,createdAt,updatedAt:createdAt});
      return learning.appendAssistant(discussion.id,syntheticMarkdown,id);
    }
    const rootMessage=addSyntheticAnswer(root);const exact='合成概念';const origin={messageId:rootMessage.id,start:rootMessage.text.indexOf(exact),end:rootMessage.text.indexOf(exact)+exact.length,exact};
    const siblings:Discussion[]=[];
    for(let index=0;index<24;index++){
      const node=learning.createBranch({parentId:root.id,title:`同级 ${String(index+1).padStart(3,'0')} · 合成规模验收概念`,origin});
      const nodeMessage=addSyntheticAnswer(node);learning.updateDiscussion(node.id,{draft:`同级 ${index+1} 的独立合成草稿`,scrollTop:0});siblings.push(node);
      const childStart=nodeMessage.text.indexOf(exact);
      for(let child=1;child<=19;child++){
        const leaf=learning.createBranch({parentId:node.id,title:`同级 ${String(index+1).padStart(3,'0')} 的子讨论 ${String(child).padStart(2,'0')} · 合成记录`,origin:{messageId:nodeMessage.id,start:childStart,end:childStart+exact.length,exact}});
        addSyntheticAnswer(leaf);learning.updateDiscussion(leaf.id,{draft:`子讨论 ${index+1}-${child} 的合成草稿`,scrollTop:0});
      }
    }
    const path=[root];let parent=root;let message=rootMessage;
    for(let depth=2;depth<=20;depth++){
      const start=message.text.indexOf(exact);const node=learning.createBranch({parentId:parent.id,title:`第${String(depth).padStart(2,'0')}层 · 用于检验完整祖先路径和超长标题换行的合成概念讨论`,origin:{messageId:message.id,start,end:start+exact.length,exact}});
      message=addSyntheticAnswer(node);learning.updateDiscussion(node.id,{draft:`深度 ${depth} 的合成草稿，不与兄弟讨论共享。`,scrollTop:0});path.push(node);parent=node;
    }
    const workspace=store.list('workspaces',book.id)[0];
    store.put('workspaces',{...workspace,activeDiscussionId:parent.id,position:{fileVersionId:book.fileVersionId,cfi:'epubcfi(/6/2[chapter1]!/4/4/1:0)',chapter:'第一章',progress:0.1},collapsed:[],fontSize:22,updatedAt:new Date().toISOString()});
    const retrievedId=randomUUID();const unavailableId=randomUUID();const quote='Synthetic source quotation for UI state testing only.';
    for(const candidate of [
      {id:retrievedId,title:'合成候选 A · retrieved 状态 fixture',quote,evidenceHash:createHash('sha256').update(quote).digest('hex'),retrieval:'retrieved' as const},
      {id:unavailableId,title:'合成候选 B · unavailable 状态 fixture',quote:'',evidenceHash:'',retrieval:'unavailable' as const},
    ])store.put('sources',{...candidate,bookId:book.id,discussionId:parent.id,fileVersionId:null,language:'en',version:'合成版本，非真实来源证据',locator:'synthetic paragraph 1',url:'https://example.invalid/momentread-synthetic-source',verification:'unverified',selected:false,reason:'仅预置合成候选状态；没有进行真实网络取回或原著核对。',createdAt:new Date().toISOString()});
    const manifest={synthetic:true,modelInvocations:0,dataDir:directory,bookId:book.id,rootId:root.id,deepestId:parent.id,discussionCount:store.list('discussions',book.id).length,path:path.map(node=>({id:node.id,title:node.title})),siblingIds:siblings.map(node=>node.id),sourceIds:{retrieved:retrievedId,unavailable:unavailableId}};
    if(manifest.discussionCount!==500||manifest.path.length!==20)throw new Error('Unexpected scale fixture dimensions');
    await writeFile(join(directory,'scale-manifest.json'),JSON.stringify(manifest,null,2));return manifest;
  } finally {store.close();}
}

if(process.argv[1]?.endsWith('seed-scale.ts')){seedScale(process.argv[2]).then(manifest=>console.log(JSON.stringify(manifest,null,2))).catch(error=>{console.error(error);process.exitCode=1;});}
