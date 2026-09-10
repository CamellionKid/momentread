import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Server-only static Markdown; no raw HTML or remote media execution. */
export function renderMarkdown(text: string): string {
 return renderToStaticMarkup(createElement(ReactMarkdown,{
  remarkPlugins:[remarkGfm],
  components:{
   img:({alt})=>createElement('span',{},`[图片未自动加载${alt?`：${alt}`:''}]`),
   a:({href,children})=>{
    let safe:string|undefined;
    if(href?.startsWith('#'))safe=href;
    else try{const url=new URL(href||'');if(['https:','http:','mailto:'].includes(url.protocol))safe=url.href}catch{}
    return safe?createElement('a',{href:safe,rel:'noreferrer noopener'},children):createElement('span',{},children);
   },
   table:({children})=>createElement('div',{className:'table-scroll'},createElement('table',{},children)),
  },
 },text));
}
