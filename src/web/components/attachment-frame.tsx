import { useEffect, useRef } from 'react';

const framePolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

export const escapeForwarder =
  "<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage('nod:close','*')},true)</script>";

export function sandboxedDocument(content: string, head = '') {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${framePolicy}"><meta name="referrer" content="no-referrer"><base target="_blank">${head}${content}`;
}

export function SandboxedFrame({
  html,
  title,
  scripts = false,
  onLeave,
}: {
  html: string;
  title: string;
  scripts?: boolean;
  onLeave(): void;
}) {
  const loads = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const leave = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data === 'nod:leave') onLeave();
    };
    window.addEventListener('message', leave);
    return () => window.removeEventListener('message', leave);
  }, [onLeave]);
  const permissions = scripts ? 'allow-scripts' : 'allow-popups allow-popups-to-escape-sandbox';
  const source = html.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${framePolicy}; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><iframe title="File content" sandbox="${permissions}" referrerpolicy="no-referrer" srcdoc="${source}" onload="if(this.dataset.loaded)parent.postMessage('nod:leave','*');this.dataset.loaded='yes'"></iframe><script>addEventListener('securitypolicyviolation',function(e){if(e.effectiveDirective==='frame-src')parent.postMessage('nod:leave','*')});addEventListener('message',function(e){if(e.source===document.querySelector('iframe').contentWindow&&e.data==='nod:close')parent.postMessage(e.data,'*')})</script>`;
  return (
    <iframe
      ref={frame}
      className="artifact-frame"
      title={title}
      sandbox={scripts ? permissions : `allow-scripts ${permissions}`}
      referrerPolicy="no-referrer"
      srcDoc={page}
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) onLeave();
      }}
    />
  );
}

const rasterImage = /^data:image\/(?:png|jpeg|gif|webp|bmp);/i;

export async function documentHtml(buffer: ArrayBuffer) {
  const { convertToHtml } = await import('mammoth');
  const { value } = await convertToHtml(
    { arrayBuffer: buffer },
    {
      styleMap: [
        "p[style-name='Title'] => h1.title:fresh",
        "p[style-name='Subtitle'] => p.subtitle:fresh",
      ],
    },
  );
  const page = new DOMParser().parseFromString(value, 'text/html');
  for (const link of Array.from(page.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else if (!href.startsWith('#')) link.removeAttribute('href');
  }
  for (const image of Array.from(page.querySelectorAll('img')))
    if (!rasterImage.test(image.getAttribute('src') ?? '')) image.remove();
  return {
    html: page.body.innerHTML,
    words: (page.body.textContent ?? '').split(/\s+/).filter(Boolean).length,
  };
}

export function documentFrame(body: string, stage: string) {
  return sandboxedDocument(
    `<main>${body}</main>`,
    `<style>
      :root { color-scheme: light; }
      html { background: ${stage}; }
      body { margin: 0; padding: 32px 24px 56px; color: #191919; font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
      main { box-sizing: border-box; max-width: 816px; min-height: calc(100vh - 88px); margin: 0 auto; padding: 72px 80px; background: #fff; border-radius: 4px; box-shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 12px 32px rgb(0 0 0 / 8%); overflow-wrap: anywhere; }
      main > :first-child { margin-top: 0; }
      h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.3; margin: 1.6em 0 0.5em; text-wrap: balance; }
      h1 { font-size: 28px; } h1.title { font-size: 34px; letter-spacing: -0.01em; margin-bottom: 8px; } .subtitle { color: #676767; font-size: 17px; } h2 { font-size: 22px; } h3 { font-size: 18px; } h4, h5, h6 { font-size: 15px; }
      p { margin: 0 0 12px; text-wrap: pretty; }
      ul, ol { margin: 0 0 12px; padding-left: 24px; }
      li { margin: 4px 0; }
      a { color: #87003c; text-underline-offset: 3px; }
      img { max-width: 100%; height: auto; }
      table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 6px 10px; border: 1px solid #d6d6d6; text-align: left; vertical-align: top; }
      th { background: #f5f5f5; font-weight: 600; }
      td p, th p { margin: 0; }
      blockquote { margin: 16px 0; padding-left: 16px; border-left: 3px solid #e0e0e0; color: #464646; }
      @media (max-width: 640px) { body { padding: 16px 12px 32px; } main { padding: 32px 24px; } }
    </style>`,
  );
}
