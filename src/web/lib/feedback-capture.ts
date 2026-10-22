import { feedbackLimits } from '../../shared/feedback';
import { desktopFeedbackScreenshot } from './desktop';

const privateContent =
  '[data-analytics-private], .browser-handoff, .pending-attachments, input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], dialog[open], [role="dialog"], [role="alertdialog"], iframe, webview';

let capturedFonts = '';

async function captureFonts(signal: AbortSignal) {
  if (capturedFonts) return capturedFonts;
  const rules = Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules).filter((rule) => rule.type === CSSRule.FONT_FACE_RULE);
    } catch {
      return [];
    }
  });
  const embedded = await Promise.all(
    rules.slice(0, 4).map(async (rule) => {
      const source = /url\(["']?([^"')]+)["']?\)/.exec(rule.cssText);
      if (!source) return '';
      const url = new URL(source[1], window.location.href);
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/fonts/') ||
        url.search ||
        url.hash
      )
        return '';
      try {
        const response = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal });
        if (!response.ok) return '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 512 * 1024) return '';
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const style = (rule as CSSFontFaceRule).style;
        const descriptors = Array.from(style)
          .filter((property) => property !== 'src')
          .map((property) => `${property}: ${style.getPropertyValue(property)};`)
          .join(' ');
        return `@font-face { ${descriptors} src: url("data:font/woff2;base64,${btoa(binary)}"); }`;
      } catch {
        return '';
      }
    }),
  );
  capturedFonts = embedded.join('\n');
  return capturedFonts;
}

function canCapture() {
  return (
    !/^\/(?:activity|logins|vault|credentials|browser|browser-connect|onboarding)(?:\/|$)/.test(
      window.location.pathname,
    ) &&
    !document.querySelector(privateContent) &&
    !Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).some((element) => {
      if (element instanceof HTMLInputElement)
        return (
          !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].includes(
            element.type,
          ) && !!element.value
        );
      if (element instanceof HTMLTextAreaElement) return !!element.value;
      return (
        element.getAttribute('contenteditable')?.toLowerCase() !== 'false' &&
        (!!element.textContent?.trim() ||
          !!element.querySelector('img, canvas, video, audio, svg, iframe, object, embed'))
      );
    })
  );
}

function cloneViewport() {
  const started = performance.now();
  let count = 0;
  const copy = (source: Node): Node | null => {
    if (++count > 12_000 || performance.now() - started > 350)
      throw new Error('The page is too large to capture.');
    if (!(source instanceof Element)) return source.cloneNode(false);
    if (source.matches('script, style, link, iframe, webview, object, embed, source, video, audio'))
      return null;
    const computed = window.getComputedStyle(source);
    if (computed.display === 'none' || computed.visibility === 'hidden') return null;
    const clone = document.createElementNS(source.namespaceURI, source.localName) as
      HTMLElement | SVGElement;
    for (const attribute of Array.from(source.attributes))
      if (
        !attribute.name.startsWith('on') &&
        !attribute.name.startsWith('xmlns') &&
        !['src', 'srcset', 'href', 'xlink:href', 'style', 'value', 'poster', 'background'].includes(
          attribute.name,
        ) &&
        !/url\(|image-set\(/i.test(attribute.value)
      ) {
        if (attribute.namespaceURI)
          clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
        else clone.setAttribute(attribute.name, attribute.value);
      }
    for (const property of Array.from(computed)) {
      const value = computed.getPropertyValue(property);
      if (!/url\(|image-set\(/i.test(value)) clone.style.setProperty(property, value);
    }
    clone.style.setProperty('animation', 'none');
    clone.style.setProperty('transition', 'none');
    if (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement) {
      const canvas = document.createElement('canvas');
      canvas.width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
      canvas.height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
      if (canvas.width && canvas.height && canvas.width * canvas.height <= 8_000_000) {
        try {
          canvas.getContext('2d')?.drawImage(source, 0, 0);
          const image = document.createElement('img');
          image.style.cssText = clone.style.cssText;
          image.src = canvas.toDataURL('image/png');
          return image;
        } catch {}
      }
      return clone;
    }
    if (source instanceof HTMLInputElement) {
      if (source.checked) clone.setAttribute('checked', '');
    }
    if (
      source instanceof HTMLTextAreaElement ||
      source.matches('[contenteditable]:not([contenteditable="false" i])')
    )
      clone.textContent = '';
    else {
      for (const child of Array.from(source.childNodes)) {
        const copied = copy(child);
        if (copied) clone.appendChild(copied);
      }
    }
    if (source.scrollTop || source.scrollLeft) {
      const scrolled = document.createElement('div');
      scrolled.style.transform = `translate(${-source.scrollLeft}px, ${-source.scrollTop}px)`;
      scrolled.style.width = `${source.scrollWidth}px`;
      while (clone.firstChild) scrolled.appendChild(clone.firstChild);
      clone.appendChild(scrolled);
    }
    return clone;
  };
  return copy(document.body) as HTMLElement;
}

async function captureWebViewport(signal: AbortSignal) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height) return null;
  const fonts = await captureFonts(signal);
  if (signal.aborted || !canCapture()) return null;
  const clone = cloneViewport();
  if (fonts) {
    const style = document.createElement('style');
    style.textContent = fonts;
    clone.prepend(style);
  }
  clone.style.margin = '0';
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  const markup = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      image.src = '';
      finish(false);
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  if (!(await loaded) || signal.aborted) return null;
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = window.getComputedStyle(document.documentElement).backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

export async function captureFeedbackScreenshot(): Promise<File | null> {
  if (!canCapture()) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1_200);
  const cancelled = new Promise<null>((resolve) =>
    controller.signal.addEventListener('abort', () => resolve(null), { once: true }),
  );
  try {
    const capture = async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!canCapture() || controller.signal.aborted) return null;
      const native = desktopFeedbackScreenshot();
      const blob = native
        ? await native.then((bytes) =>
            bytes?.length ? new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }) : null,
          )
        : await captureWebViewport(controller.signal);
      if (
        !blob?.size ||
        blob.size > feedbackLimits.attachmentBytes ||
        !canCapture() ||
        controller.signal.aborted
      )
        return null;
      return new File([blob], 'nod-screenshot.jpg', { type: 'image/jpeg' });
    };
    return await Promise.race([capture(), cancelled]);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
    controller.abort();
  }
}
