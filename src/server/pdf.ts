import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export type PdfText = [x: number, y: number, size: number, font: 1 | 2 | 3, text: string];

type Markdown = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  children?: Markdown[];
};

const winAnsi = new Map(
  [...'€ ‚ƒ„…†‡ˆ‰Š‹Œ Ž  ‘’“”•–—˜™š›œ žŸ']
    .map((char, index) => [char, 0x80 + index] as const)
    .filter(([char]) => char !== ' '),
);

function encoded(char: string) {
  const code = char.codePointAt(0)!;
  return (
    winAnsi.get(char) ?? ((code >= 32 && code < 127) || (code >= 160 && code <= 255) ? code : 0)
  );
}

function pdfText(value: string) {
  const bytes = [
    ...value
      .replace(/ ?(?:(?![©®™])[\p{Extended_Pictographic}\u200d\ufe0f])+/gu, '')
      .replace(/→/g, '->')
      .replace(/←/g, '<-'),
  ].map((char) => {
    const mapped = encoded(char) || 63;
    const byte = String.fromCharCode(mapped);
    return mapped === 40 || mapped === 41 || mapped === 92 ? `\\${byte}` : byte;
  });
  return `(${bytes.join('')})`;
}

const helvetica = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const helveticaBold = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const narrow: Record<string, number> = {
  '•': 350,
  '€': 556,
  '‘': 278,
  '’': 278,
  '“': 500,
  '”': 500,
};

function glyphWidth(char: string, font: PdfText[3]) {
  if (font === 3) return 600;
  const code = (char.normalize('NFD')[0] ?? char).charCodeAt(0);
  return (
    (code >= 32 && code < 127
      ? (font === 2 ? helveticaBold : helvetica)[code - 32]
      : narrow[char]) ?? 1000
  );
}

export const textWidth = (text: string, size: number, font: PdfText[3] = 1) =>
  ([...text].reduce((sum, char) => sum + glyphWidth(char, font), 0) * size) / 1000;

export function pdfFile(pages: PdfText[][]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    ...['Helvetica', 'Helvetica-Bold', 'Courier'].map(
      (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
    ),
  ];
  const kids: number[] = [];
  for (const page of pages) {
    const stream = page
      .map(
        ([x, y, size, font, text]) => `BT /F${font} ${size} Tf ${x} ${y} Td ${pdfText(text)} Tj ET`,
      )
      .join('\n');
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${objects.length} 0 R >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, 'latin1');
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function chunks(text: string, width: number, size: number, font: PdfText[3]) {
  const parts = [''];
  let used = 0;
  for (const char of text) {
    const wide = textWidth(char, size, font);
    if (parts.at(-1) && used + wide > width) {
      parts.push('');
      used = 0;
    }
    parts[parts.length - 1] += char;
    used += wide;
  }
  return parts;
}

function wrap(text: string, width: number, size: number, font: PdfText[3]) {
  const space = textWidth(' ', size, font);
  return text.split('\n').flatMap((part) => {
    const lines = [''];
    let used = 0;
    for (const piece of part
      .split(/\s+/)
      .flatMap((word) => (word ? chunks(word, width, size, font) : []))) {
      const wide = textWidth(piece, size, font);
      if (lines.at(-1) && used + space + wide <= width) {
        lines[lines.length - 1] += ` ${piece}`;
        used += space + wide;
      } else {
        if (lines.at(-1)) lines.push(piece);
        else lines[lines.length - 1] = piece;
        used = wide;
      }
    }
    return lines;
  });
}

function inline(node: Markdown): string {
  if (node.type === 'text' || node.type === 'inlineCode')
    return (node.value ?? '').replace(/\n/g, ' ');
  if (node.type === 'break') return '\n';
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'html') return (node.value ?? '').replace(/<[^>]*>/g, '');
  const text = (node.children ?? []).map(inline).join('');
  return node.type === 'link' && /^https?:\/\//i.test(node.url ?? '') && text !== node.url
    ? `${text} (${node.url})`
    : text;
}

function renderMarkdown(input: string) {
  const markdown = input.normalize('NFC');
  if ([...markdown].some((char) => /[\p{L}\p{M}]/u.test(char) && !encoded(char))) return undefined;
  const pages: PdfText[][] = [[]];
  let y = 790;
  const line = (x: number, size: number, font: PdfText[3], text: string) => {
    if (y < 60) {
      pages.push([]);
      y = 790;
    }
    pages.at(-1)!.push([x, y, size, font, text]);
    y -= size * 1.4;
  };
  const room = (x: number) => Math.max(539 - x, 40);
  const write = (text: string, x: number, size = 10, font: PdfText[3] = 1, marker = '') => {
    const indent = textWidth(marker, size, font);
    wrap(text, room(x + indent), size, font).forEach((part, index) =>
      line(index ? x + indent : x, size, font, index ? part : marker + part),
    );
  };
  const block = (node: Markdown, x: number, marker = '') => {
    const children = node.children ?? [];
    if (node.type === 'heading') {
      y -= 8;
      write(inline(node), x, [0, 18, 15, 13][node.depth ?? 4] ?? 11, 2);
      y -= 4;
    } else if (node.type === 'paragraph') {
      write(inline(node), x, 10, 1, marker);
      y -= marker ? 2 : 6;
    } else if (node.type === 'code') {
      for (const source of (node.value ?? '').replace(/\t/g, '    ').split('\n'))
        for (const part of chunks(source, room(x), 9, 3)) line(x, 9, 3, part);
      y -= 6;
    } else if (node.type === 'list')
      children.forEach((item, index) =>
        block(item, x, node.ordered ? `${(node.start ?? 1) + index}. ` : '• '),
      );
    else if (node.type === 'listItem') {
      const mark = node.checked === true ? '[x] ' : node.checked === false ? '[ ] ' : marker;
      children.forEach((child, index) =>
        block(child, index ? x + textWidth(mark, 10) : x, index ? '' : mark),
      );
    } else if (node.type === 'blockquote') children.forEach((child) => block(child, x + 14));
    else if (node.type === 'table') {
      children.forEach((row, index) =>
        write((row.children ?? []).map(inline).join('  |  '), x, 10, index ? 1 : 2),
      );
      y -= 6;
    } else if (node.type === 'thematicBreak') y -= 10;
    else if (children.length) children.forEach((child) => block(child, x, marker));
    else if (node.value) write(inline(node), x);
  };
  for (const node of (unified().use(remarkParse).use(remarkGfm).parse(markdown) as Markdown)
    .children ?? [])
    block(node, 56);
  return pdfFile(pages);
}

export function markdownPdf(markdown: string) {
  if (markdown.length > 200_000) return Promise.resolve(undefined);
  return new Promise<Uint8Array | undefined>((resolve) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { markdownPdf: markdown },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => void worker.terminate(), 5_000);
    worker.once('message', (bytes: Uint8Array | null) => resolve(bytes ?? undefined));
    worker.once('error', () => resolve(undefined));
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  }).catch(() => undefined);
}

if (!isMainThread && typeof workerData?.markdownPdf === 'string')
  parentPort?.postMessage(renderMarkdown(workerData.markdownPdf) ?? null);
