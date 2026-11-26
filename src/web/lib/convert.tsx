import type { AttachmentKind } from '../../shared/attachment-kind';
import { textPreviewBytes } from './attachment-kind';
import { printDocument } from './print';

export type ExportFormat = 'pdf' | 'xlsx' | 'csv';

export const exportFormats: Partial<
  Record<AttachmentKind, { format: ExportFormat; label: string }>
> = {
  html: { format: 'pdf', label: 'PDF' },
  markdown: { format: 'pdf', label: 'PDF' },
  csv: { format: 'xlsx', label: 'Excel file' },
  spreadsheet: { format: 'csv', label: 'CSV file' },
};

export function csvDelimiter(text: string, name: string, mimeType: string) {
  if (/\.tsv$/i.test(name) || mimeType.includes('tab-separated')) return '\t';
  const line = text.slice(0, text.search(/\r?\n|$/));
  return [',', ';', '\t']
    .map((value) => ({ value, count: line.split(value).length }))
    .sort((a, b) => b.count - a.count)[0].value;
}

const plainNumber = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;
const printStyle =
  '<style>body{margin:0;font:11pt/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#191919}h1,h2,h3,h4{line-height:1.25;break-after:avoid}h1{font-size:20pt}h2{font-size:15pt}h3{font-size:12pt}pre,code{font:9.5pt/1.45 ui-monospace,Menlo,Consolas,monospace}pre{padding:10pt;border:1px solid #d9d9d9;border-radius:6pt;white-space:pre-wrap;break-inside:avoid}table{width:100%;border-collapse:collapse;font-size:10pt}th,td{padding:5pt 7pt;border:1px solid #d9d9d9;text-align:left;vertical-align:top}tr{break-inside:avoid}blockquote{margin:0;padding-left:12pt;border-left:2pt solid #d9d9d9;color:#555}a{color:inherit}@page{margin:18mm}</style>';

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportFile(
  url: string,
  name: string,
  mimeType: string,
  kind: AttachmentKind,
  format: ExportFormat,
) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
  const data = await response.arrayBuffer();
  if (data.byteLength > textPreviewBytes)
    throw new Error('This file is too large to convert. Files up to 4 MB can be converted.');
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  if (format === 'pdf') {
    const text = new TextDecoder().decode(data);
    if (kind === 'html') return printDocument(text);
    const [{ renderToStaticMarkup }, { default: Markdown }, { default: remarkGfm }] =
      await Promise.all([
        import('react-dom/server'),
        import('react-markdown'),
        import('remark-gfm'),
      ]);
    return printDocument(
      printStyle +
        renderToStaticMarkup(
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{ img: ({ alt }) => <span>{alt || 'Image'}</span> }}
          >
            {text}
          </Markdown>,
        ),
    );
  }
  const { read, utils, write } = await import('@e965/xlsx');
  if (format === 'xlsx') {
    const text = new TextDecoder().decode(data);
    const workbook = read(text, {
      type: 'string',
      raw: true,
      FS: csvDelimiter(text, name, mimeType),
    });
    for (const sheet of Object.values(workbook.Sheets))
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith('!') || cell.t !== 's' || !plainNumber.test(cell.v)) continue;
        cell.t = 'n';
        cell.v = Number(cell.v);
        delete cell.w;
      }
    return save(
      new Blob([write(workbook, { type: 'array', bookType: 'xlsx' })], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      `${stem}.xlsx`,
    );
  }
  const workbook = read(data, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('This spreadsheet has no sheets to convert.');
  save(new Blob(['﻿', utils.sheet_to_csv(sheet)], { type: 'text/csv' }), `${stem}.csv`);
}
