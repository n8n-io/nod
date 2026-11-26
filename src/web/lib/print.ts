export const printSandbox = 'allow-scripts allow-modals';

export function printSource(content: string, nonce: string) {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script nonce="${nonce}">addEventListener('afterprint',function(){parent.postMessage('nod:printed','*')});addEventListener('load',function(){setTimeout(function(){print()},100)})</script>${content}`;
}

export function printDocument(content: string) {
  const frame = document.createElement('iframe');
  frame.title = 'Print';
  frame.setAttribute('sandbox', printSandbox);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText =
    'position:fixed;left:0;top:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none;color-scheme:light';
  const finish = () => {
    window.removeEventListener('message', printed);
    window.clearTimeout(timer);
    frame.remove();
  };
  const printed = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.data === 'nod:printed') finish();
  };
  const timer = window.setTimeout(finish, 10 * 60 * 1000);
  window.addEventListener('message', printed);
  frame.srcdoc = printSource(content, crypto.randomUUID().replaceAll('-', ''));
  document.body.append(frame);
}
