import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { JSDOM } from 'jsdom';
import { fakeDevtools } from './browser-fixture.ts';
import type { runProcess } from '../src/providers/process.ts';

class LoginPage {
  stage: 'identifier' | 'password' | 'otp' | 'complete' = 'identifier';
  location = { origin: 'https://1.1.1.1', href: 'https://1.1.1.1/login' };
  dom = new JSDOM('', { url: this.location.href, runScripts: 'outside-only' });
  input!: HTMLInputElement;
  search!: HTMLInputElement;
  next!: HTMLButtonElement;
  entered: string[] = [];
  document = 'loader-0';
  isolated: Record<string, unknown> = {};
  focused?: HTMLInputElement;
  afterInspect?(expression: string): void;
  refs = new Map<string, Element>();
  constructor() {
    this.dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
    Object.defineProperty(this.dom.window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    this.render();
  }
  render() {
    this.dom.window.document.execCommand = (command: string, _ui?: boolean, value?: string) => {
      const node = this.dom.window.document.activeElement as HTMLInputElement;
      if (!node || !('value' in node)) return false;
      if (command === 'delete') node.value = '';
      if (command === 'insertText') {
        node.value += value ?? '';
        node.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
      }
      return true;
    };
    this.dom.window.document.body.innerHTML = `<h1>Sign in ${this.stage}</h1><form><label>Account<input id="account"></label><button type="button" disabled>Next</button></form><input id="search" aria-label="Search"><div id="echo"></div>`;
    this.input = this.dom.window.document.querySelector('#account')!;
    this.input.name = this.stage;
    this.input.autocomplete =
      this.stage === 'identifier'
        ? 'username'
        : this.stage === 'otp'
          ? 'one-time-code'
          : 'current-password';
    this.input.type = this.stage === 'password' ? 'password' : 'text';
    this.search = this.dom.window.document.querySelector('#search')!;
    this.next = this.dom.window.document.querySelector('button')!;
    this.dom.window.document.querySelector('#echo')!.textContent = this.entered.join(' ');
    this.input.addEventListener('input', () => {
      this.next.disabled = false;
    });
    this.next.addEventListener('click', () => {
      this.entered.push(this.input.value);
      this.stage =
        this.stage === 'identifier' ? 'password' : this.stage === 'password' ? 'otp' : 'complete';
      this.render();
    });
    if (this.stage === 'complete') this.input.remove();
  }
  nodes(selector: string): Element[] {
    if (selector.startsWith('@')) {
      const node = this.refs.get(selector);
      return node?.isConnected ? [node] : [];
    }
    return [...this.dom.window.document.querySelectorAll(selector)];
  }
  snapshot() {
    const lines = [this.text()];
    const refs: Record<string, { role: string; name: string }> = {};
    for (const node of this.dom.window.document.querySelectorAll('input,button')) {
      let ref = [...this.refs].find(([, element]) => element === node)?.[0];
      if (!ref) {
        ref = `@e${this.refs.size + 1}`;
        this.refs.set(ref, node);
      }
      const role = node.tagName === 'INPUT' ? 'textbox' : 'button';
      const name = node.getAttribute('aria-label') ?? node.id ?? 'Next';
      refs[ref.slice(1)] = { role, name };
      lines.push(
        `- ${role} "${name}" [ref=${ref.slice(1)}]${node.tagName === 'INPUT' ? `: ${(node as HTMLInputElement).value}` : ''}`,
      );
    }
    return { snapshot: lines.join('\n'), refs };
  }
  text() {
    return this.dom.window.document.body.textContent ?? '';
  }
  screen() {
    const echo = this.dom.window.document.querySelector<HTMLElement>('#echo')!;
    const style = this.dom.window.getComputedStyle(echo);
    return `Screen ${this.stage} ${style.color === 'transparent' || style.opacity === '0' || style.visibility === 'hidden' ? '[redacted]' : echo.textContent}`;
  }
  async evaluate(script: string) {
    this.dom.reconfigure({ url: this.location.href });
    return this.dom.window.eval(script) as unknown;
  }
}

export function stagedLoginBrowser() {
  const pages = new Map<string, LoginPage>();
  const inspectors = new Map<string, Awaited<ReturnType<typeof fakeDevtools>>>();
  let documents = 0;
  const run: typeof runProcess = async (_executable, args, options) => {
    const id = basename(args[args.indexOf('--profile') + 1]);
    let page = pages.get(id);
    if (!page) {
      page = new LoginPage();
      pages.set(id, page);
      page.document = `loader-${++documents}`;
    }
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    let data: Record<string, unknown> = {};
    if (command[0] === 'get' && command[1] === 'cdp-url' && !inspectors.has(id)) {
      const target = page;
      const inspector = await fakeDevtools({
        get document() {
          return target.document;
        },
        get frames() {
          return [{ id: 'main', session: 'page', origin: target.location.origin }];
        },
        frameOf: {},
        values: new Map(),
        evaluate: (expression) => {
          const value = new Function(
            'document',
            'globalThis',
            'Event',
            'NodeFilter',
            'getComputedStyle',
            'MutationObserver',
            `return ${expression}`,
          )(
            target.dom.window.document,
            target.isolated,
            target.dom.window.Event,
            target.dom.window.NodeFilter,
            target.dom.window.getComputedStyle.bind(target.dom.window),
            target.dom.window.MutationObserver,
          );
          target.afterInspect?.(expression);
          return value;
        },
      });
      inspectors.set(id, inspector);
    }
    if (command[0] === 'focus')
      page.nodes(command[1])[0]?.dispatchEvent(new page.dom.window.Event('focus'));
    if (command[0] === 'focus') (page.nodes(command[1])[0] as HTMLElement | undefined)?.focus();
    if (command[0] === 'press' && command[1] === 'Enter') page.next.click();
    if (command[0] === 'reload') {
      page.dom.window.close();
      page.dom = new JSDOM('', { url: page.location.href, runScripts: 'outside-only' });
      page.isolated = {};
      page.document = `loader-${++documents}`;
      page.render();
    }
    if (command[0] === 'get')
      data =
        command[1] === 'url'
          ? { url: page.location.href }
          : command[1] === 'cdp-url'
            ? { cdpUrl: inspectors.get(id)!.url }
            : { value: page.nodes(command[2])[0]?.getAttribute(command[3]) ?? null };
    if (command[0] === 'eval') data = { result: await page.evaluate(options?.input ?? '') };
    if (command[0] === 'click') {
      const node = page.nodes(command[1])[0] as HTMLElement | undefined;
      node?.focus();
      node?.click();
    }
    if (command[0] === 'keyboard' && command[1] === 'type') {
      const node = page.dom.window.document.activeElement;
      if (node instanceof page.dom.window.HTMLInputElement) {
        node.value += command[2];
        node.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
      }
    }
    if (command[0] === 'fill') {
      const node = page.nodes(command[1])[0] as HTMLInputElement | undefined;
      if (node) {
        page.focused = node;
        node.value = command[2];
        node.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
      }
    }
    if (command[0] === 'press' && page.focused && command[1].length === 1) {
      page.focused.value += command[1];
      page.focused.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
    }
    if (command[0] === 'snapshot') data = page.snapshot();
    if (command[0] === 'screenshot') await writeFile(command[1], page.screen());
    if (command[0] === 'close') {
      page.dom.window.close();
      pages.delete(id);
      await inspectors.get(id)?.close();
      inspectors.delete(id);
    }
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  return { run, pages };
}
