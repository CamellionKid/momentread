import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {renderMarkdown} from '../../server/exports/markdown';
describe('offline Markdown export',()=>{
 it('renders headings, emphasis, table, list and literal code without remote resources',()=>{
  const doc=new JSDOM(renderMarkdown('# 理解\n\n**或然性** 与 *必然性*\n\n- 一个问题\n\n|概念|语境|\n|--|--|\n|因果性|休谟|\n\n```html\n<script>alert(1)</script>\n```\n\n![image](https://example.com/tracker.png)')).window.document;
  expect(doc.querySelector('h1')?.textContent).toBe('理解');expect(doc.querySelector('strong')?.textContent).toBe('或然性');expect(doc.querySelector('em')?.textContent).toBe('必然性');expect(doc.querySelectorAll('td')).toHaveLength(2);expect(doc.querySelector('li')?.textContent).toBe('一个问题');expect(doc.querySelector('pre code')?.textContent).toContain('<script>');expect(doc.querySelectorAll('script,img,iframe')).toHaveLength(0);
 });
 it('keeps HTML as inert visible text and rejects unsafe or local navigation',()=>{
  const doc=new JSDOM(renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [local](/api/restore) [source](https://example.com/source)')).window.document;
  expect(doc.querySelectorAll('script')).toHaveLength(0);expect(doc.body.textContent).toContain('<script>alert(1)</script>');expect([...doc.querySelectorAll('a')].map(a=>a.getAttribute('href'))).toEqual(['https://example.com/source']);
 });
});
