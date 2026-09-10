import {describe,expect,it,vi} from 'vitest';
import {htmlText,isPublicAddress,normalizeText,publicTarget} from '../../server/matching/network';

describe('public original source boundary',()=>{
  it.each(['127.0.0.1','0.0.0.0','10.2.3.4','100.64.1.2','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.1.1','198.51.100.8','203.0.113.5','224.1.1.1','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])('rejects nonpublic address %s',address=>expect(isPublicAddress(address)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','185.15.59.224','2606:4700:4700::1111','2001:4860:4860::8888'])('permits routed address %s',address=>expect(isPublicAddress(address)).toBe(true));
  it.each(['file:///etc/passwd','ftp://example.org/a','https://localhost/a','https://book.local/a','http://user:secret@example.org/a','https://example.org:8080/a','http://2130706433/a','http://0x7f000001/a','http://[::1]/a'])('blocks unsafe URL %s',async url=>{
    const lookup=vi.fn(async()=>[{address:'8.8.8.8',family:4}]);
    await expect(publicTarget(url,lookup)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects a public name with any private DNS answer',async()=>{
    await expect(publicTarget('https://example.org/',async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}])).rejects.toMatchObject({code:'SOURCE_URL_BLOCKED'});
  });
  it('uses trusted resolution only for fake-IP hostnames and rechecks the result',async()=>{
    const fallback=vi.fn(async()=>[{address:'8.8.8.8',family:4}]);
    const target=await publicTarget('https://example.org/',async()=>[{address:'198.18.2.3',family:4}],fallback);expect(target.address.address).toBe('8.8.8.8');expect(fallback).toHaveBeenCalledExactlyOnceWith('example.org');
    await expect(publicTarget('https://example.org/',async()=>[{address:'198.18.2.3',family:4}],async()=>[{address:'10.0.0.1',family:4}])).rejects.toMatchObject({code:'SOURCE_URL_BLOCKED'});
    fallback.mockClear();await expect(publicTarget('https://example.org/',async()=>[{address:'192.168.0.1',family:4}],fallback)).rejects.toThrow();expect(fallback).not.toHaveBeenCalled();
    await expect(publicTarget('https://198.18.2.3/',async()=>[],fallback)).rejects.toThrow();expect(fallback).not.toHaveBeenCalled();
  });
  it('returns the resolved address for a pinned request and removes fragment',async()=>{
    const lookup=vi.fn(async()=>[{address:'8.8.8.8',family:4}]);const target=await publicTarget('https://example.org/chapter#p2',lookup);
    expect(target.address).toEqual({address:'8.8.8.8',family:4});expect(target.url.href).toBe('https://example.org/chapter');expect(lookup).toHaveBeenCalledExactlyOnceWith('example.org');
  });
  it('extracts inert text and decodes entities without running scripts or changing wording',()=>{
    const text=htmlText('<p>Vernunft &amp; Erfahrung.</p><script>MAGIC_BAD()</script><style>bad</style><p>Ego&nbsp;sum, &ldquo;existo&rdquo;.</p>');
    expect(text).toBe('Vernunft & Erfahrung. Ego sum, “existo”.');expect(text).not.toContain('MAGIC');
    expect(normalizeText('cafe\u0301\n experience')).toBe('café experience');
  });
});
