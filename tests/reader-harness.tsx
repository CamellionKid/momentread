/** Standalone synthetic browser fixture: no network AI, user book, or database writes. */
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useState} from 'react';
import {zipSync,strToU8} from 'fflate';
import {EpubReader} from '../src/reader/EpubReader';
import type {ReaderHandle} from '../shared/contracts/ports';
import type {ReadingPosition,TextReference} from '../shared/contracts';
const packageXML = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">browser-fixture</dc:identifier><dc:title>合成阅读回归书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>';
const makePage = (title:string,text:string) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>p{font-family:Arial,sans-serif;font-weight:bold}h1{font-family:Arial,sans-serif}</style><script>top.document.getElementById('isolation-status').textContent='SCRIPT_EXECUTED'</script></head><body><h1>${title}</h1>${Array.from({length:16},(_,i)=>`<p>${i+1}：${text} 同一句话在不同位置出现，需要通过结构位置区分。</p>`).join('')}<img src="https://reader-isolation.invalid/pixel"/></body></html>`;
const archive=zipSync({mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),'package.opf':strToU8(packageXML),'nav.xhtml':strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head/><body><nav epub:type="toc"><ol><li><a href="a.xhtml">第一章 合成选区</a></li><li><a href="b.xhtml">第二章 恢复位置</a></li></ol></nav></body></html>'),'a.xhtml':strToU8(makePage('第一章 合成选区','这是一段没有版权来源的合成测试文字，用来检查字体、选区和定位。')),'b.xhtml':strToU8(makePage('第二章 恢复位置','这是第二个章节，导航与恢复必须保持该章节自己的位置。'))});
const fileUrl=URL.createObjectURL(new Blob([Uint8Array.from(archive).buffer],{type:'application/epub+zip'}));
const book={id:'9f226f41-6d60-46e6-9556-d2c7cfa60b6b',fileVersionId:'a7ae104d-f727-456e-9440-261f4f826930',title:'合成阅读回归书',author:'MomentRead tests',language:'zh',createdAt:new Date().toISOString()};
function Harness(){
 const reader=useRef<ReaderHandle>(null);const [ready,setReady]=useState(false);const [size,setSize]=useState(24);const [reference,setReference]=useState<TextReference|null>(null);const [position,setPosition]=useState<ReadingPosition|null>(null);const [saved,setSaved]=useState<ReadingPosition|null>(null);const [error,setError]=useState('');
 useEffect(()=>()=>URL.revokeObjectURL(fileUrl),[]);
 return <main style={{display:'grid',gridTemplateColumns:'minmax(450px,800px) 360px',height:'calc(100vh - 16px)',fontFamily:'system-ui'}}>
 <EpubReader ref={reader} book={book} fileUrl={fileUrl} position={null} fontSize={size} onReady={()=>setReady(true)} onSelection={setReference} onRelocate={setPosition} onError={setError}/>
 <aside style={{padding:20,overflow:'auto'}}><h1>阅读器回归</h1><p role="status">{ready?'READY':'LOADING'}</p><p id="isolation-status">SCRIPT_BLOCKED</p><p>当前章节：{position?.chapter}</p><p>进度：{position?.progress}</p><label>字号<input aria-label="回归字号" type="range" min="16" max="36" value={size} onChange={e=>setSize(Number(e.target.value))}/></label><p>字号：{size}</p><button onClick={()=>setSaved(position)}>保存测试位置</button><button disabled={!saved} onClick={()=>void reader.current?.restorePosition(saved!)}>恢复测试位置</button><button disabled={!reference} onClick={()=>void reader.current?.navigateToReference(reference!).catch(e=>setError(e.message))}>回到测试选区</button><p>已保存：{saved?.chapter}</p><p>错误：{error||'无'}</p><pre style={{whiteSpace:'pre-wrap'}} aria-label="测试选区">{reference?JSON.stringify(reference,null,2):'尚未选取'}</pre></aside>
 </main>
}
createRoot(document.getElementById('root')!).render(<Harness/>);
