// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';

class Observer {
  static instances: Observer[] = [];
  targets: Element[] = [];
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(public callback: () => void) {Observer.instances.push(this);}
  observe(target: Element) {this.targets.push(target);}
}
afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals();});
async function reader() {
  Observer.instances = [];
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  const {Paginator} = await import('../../vendor/foliate-js/paginator.js');
  const paginator = new Paginator();
  document.body.append(paginator);
  return paginator;
}

describe('reader lifecycle', () => {
  it('can be destroyed before the first chapter exists and disconnects its observer', async () => {
    const paginator = await reader();
    paginator.open({sections: []});
    expect(() => paginator.destroy()).not.toThrow();
    expect(() => paginator.destroy()).not.toThrow();
    expect(Observer.instances[0].disconnect).toHaveBeenCalled();
    expect(() => Observer.instances[0].callback()).not.toThrow();
  });

  it('does not create an iframe when a chapter resolves after the reader is destroyed', async () => {
    const paginator = await reader();
    let release!: (url: string) => void;
    const load = vi.fn(() => new Promise<string>(resolve => {release = resolve;}));
    const unload = vi.fn();
    paginator.open({sections: [{load, unload}]});
    const navigation = paginator.goTo({index: 0});
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    paginator.destroy();
    paginator.remove();
    release('about:blank');
    await navigation;
    expect(paginator.getContents()).toEqual([]);
    expect(unload).toHaveBeenCalled();
    expect(Observer.instances).toHaveLength(1);
  });

  it('ignores resize work for a detached iframe and settles its pending load on destroy', async () => {
    const paginator = await reader();
    paginator.open({sections: [{load: async () => 'about:blank'}]});
    const navigation = paginator.goTo({index: 0});
    const container = Observer.instances[0].targets[0];
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    paginator.remove();
    expect(container.querySelector('iframe')!.contentDocument).toBeNull();
    expect(() => paginator.render()).not.toThrow();
    paginator.destroy();
    await navigation;
    expect(Observer.instances.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });
});
