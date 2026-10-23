import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLinkDestinations } from '../lib/markdown';
import { Download, ExternalLink, FileText, Folder } from './icons';
import { safeMessageLink } from '../lib/message-links';
import { formatNumber } from '../lib/date-format';
import { fileSize, textPreviewBytes } from '../lib/attachment-kind';
import { ownedArtifactUrl } from '../lib/attachment-url';
import type { ImagePreview } from './attachment-images';
import { FileGlyph } from './attachment-glyph';
import { CodeView, codeLanguage, formatJson } from './attachment-code';
import {
  documentFrame,
  documentHtml,
  escapeForwarder,
  SandboxedFrame,
  sandboxedDocument,
} from './attachment-frame';
import { SlidesView } from './attachment-slides';
import { Button, Skeleton } from './ui';

export type DataKind =
  | 'markdown'
  | 'text'
  | 'csv'
  | 'spreadsheet'
  | 'html'
  | 'document'
  | 'presentation'
  | 'archive'
  | 'n8n-workflow';
type Sheet = { name: string; rows: string[][]; header: boolean; total: number; columns: number };

const previewRows = 202;
const previewColumns = 100;
const previewCellLength = 10_000;
const limits: Record<DataKind, number> = {
  markdown: textPreviewBytes,
  text: textPreviewBytes,
  csv: textPreviewBytes,
  html: textPreviewBytes,
  spreadsheet: textPreviewBytes,
  document: 25_000_000,
  presentation: 60_000_000,
  archive: 100_000_000,
  'n8n-workflow': textPreviewBytes,
};
const WorkflowCanvas = lazy(() => import('./n8n-canvas'));
const numberLike = /^[-+(]?[$€£¥]?\s?\d[\d,.\s]*%?\)?(?:\s?[$€£¥]|\s?[A-Z]{3})?$/;

export function PreviewUnavailable({
  item,
  message = 'Preview unavailable',
}: {
  item: ImagePreview;
  message?: string;
}) {
  return (
    <div className="artifact-empty" role="status">
      <FileGlyph name={item.name} mimeType={item.mimeType ?? ''} size={32} />
      <span>{message}</span>
      {item.downloadUrl && ownedArtifactUrl(item.downloadUrl) && (
        <Button variant="outline" size="sm" asChild>
          <a href={item.downloadUrl} download={item.name}>
            <Download size={16} aria-hidden="true" />
            Download
          </a>
        </Button>
      )}
    </div>
  );
}

export function PreviewLoading() {
  return (
    <div className="artifact-loading" role="status" aria-label="Loading preview">
      {[72, 88, 64, 80, 46].map((width) => (
        <Skeleton key={width} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

function SpreadsheetLink({ href }: { href: string }) {
  const host = new URL(href).hostname;
  return (
    <a
      className="attachment-table-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      aria-label={`Open ${host}`}
    >
      {host}
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

function SpreadsheetCell({ value }: { value: string }) {
  const parts = value.split(/[;\n]\s*(?=https?:\/\/)/i);
  if (parts.length > 1) {
    if (parts.length > 8) return value;
    const links = parts.map((part) => safeMessageLink(part.trim(), window.location.origin));
    if (links.some((link) => link?.kind !== 'external')) return value;
    return (
      <span className="attachment-table-links">
        {links.map((link, index) => (
          <SpreadsheetLink href={link!.href} key={`${link!.href}:${index}`} />
        ))}
      </span>
    );
  }
  const link = safeMessageLink(value, window.location.origin);
  if (link?.kind !== 'external') return value;
  return <SpreadsheetLink href={link.href} />;
}

function parseCsv(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cellStarted = false;
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      cellStarted = true;
      if (quoted && text[index + 1] === '"') {
        if (cell.length < previewCellLength) cell += '"';
        index += 1;
      } else if (!cell || quoted) quoted = !quoted;
      else if (cell.length < previewCellLength) cell += char;
    } else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      if (row.length < previewColumns) row.push(cell);
      cell = '';
      cellStarted = false;
      if (char !== delimiter) {
        total += 1;
        if (rows.length < previewRows) rows.push(row);
        row = [];
        if (char === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else {
      cellStarted = true;
      if (cell.length < previewCellLength) cell += char;
    }
  }
  if (quoted) throw new Error('Invalid CSV');
  if (row.length || cellStarted) {
    total += 1;
    if (rows.length < previewRows) rows.push([...row, cell].slice(0, previewColumns));
  }
  return { rows, total };
}

function csvDelimiter(text: string, name: string, mimeType: string) {
  if (/\.tsv$/i.test(name) || mimeType.includes('tab-separated')) return '\t';
  const line = text.slice(0, text.search(/\r?\n|$/));
  return [',', ';', '\t']
    .map((value) => ({ value, count: line.split(value).length }))
    .sort((a, b) => b.count - a.count)[0].value;
}

function columnName(index: number) {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function SheetView({ sheets, onDetail }: { sheets: Sheet[]; onDetail(detail: string): void }) {
  const [selected, setSelected] = useState(0);
  const sheet = sheets[selected];
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const headings = Array.from({ length: width }, (_, index) =>
    sheet.header ? sheet.rows[0]?.[index] || columnName(index) : columnName(index),
  );
  const rows = (sheet.header ? sheet.rows.slice(1) : sheet.rows).slice(0, 200);
  const total = Math.max(0, sheet.header ? sheet.total - 1 : sheet.total);
  const numeric = headings.map((_, column) => {
    const values = rows.map((row) => row[column]?.trim() ?? '').filter(Boolean);
    return (
      values.length > 0 &&
      values.filter((value) => numberLike.test(value)).length >= values.length * 0.8
    );
  });
  useEffect(
    () =>
      onDetail(
        `${formatNumber(total)} ${total === 1 ? 'row' : 'rows'} · ${formatNumber(sheet.columns)} ${sheet.columns === 1 ? 'column' : 'columns'}`,
      ),
    [onDetail, total, sheet.columns],
  );
  return (
    <div className="artifact-sheet">
      {width ? (
        <div
          className="artifact-sheet-scroll"
          role="region"
          aria-label={sheet.name}
          tabIndex={0}
          data-artifact-scroll=""
        >
          <table>
            <thead>
              <tr>
                <th aria-label="Row number" />
                {headings.map((heading, index) => (
                  <th key={index} scope="col" className={numeric[index] ? 'is-number' : undefined}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row">{rowIndex + 1}</th>
                  {headings.map((_, column) => (
                    <td
                      key={column}
                      className={numeric[column] ? 'is-number' : undefined}
                      title={(row[column]?.length ?? 0) > 40 ? row[column] : undefined}
                    >
                      <SpreadsheetCell value={row[column] ?? ''} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {total > rows.length && (
            <p className="artifact-sheet-limit">Showing the first {rows.length} rows.</p>
          )}
        </div>
      ) : (
        <div className="artifact-empty" role="status">
          This sheet is empty.
        </div>
      )}
      {sheets.length > 1 && (
        <div className="artifact-sheet-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((item, index) => (
            <button
              type="button"
              role="tab"
              key={`${item.name}:${index}`}
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

async function readWorkbook(buffer: ArrayBuffer): Promise<Sheet[]> {
  const { read, utils } = await import('@e965/xlsx');
  const workbook = read(buffer, { type: 'array', cellText: true, sheetRows: previewRows });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : null;
    const whole = sheet['!fullref'] ? utils.decode_range(sheet['!fullref']) : range;
    if (
      range &&
      (!Number.isFinite(range.e.r) || !Number.isFinite(range.e.c) || range.e.r < 0 || range.e.c < 0)
    )
      throw new Error('Invalid spreadsheet range');
    const rows = range
      ? (
          utils.sheet_to_json(sheet, {
            header: 1,
            raw: false,
            defval: '',
            blankrows: true,
            range: {
              s: { r: 0, c: 0 },
              e: {
                r: Math.min(range.e.r, previewRows - 1),
                c: Math.min(range.e.c, previewColumns - 1),
              },
            },
          }) as unknown[][]
        )
          .slice(0, previewRows)
          .map((row) =>
            row
              .slice(0, previewColumns)
              .map((cell) => String(cell ?? '').slice(0, previewCellLength)),
          )
      : [];
    const [first = [], ...rest] = rows;
    const header =
      first.filter(Boolean).length >= 2 &&
      first.every((cell) => !cell || !numberLike.test(cell.trim())) &&
      rest.some((row) => row.some((cell, index) => first[index] && numberLike.test(cell.trim())));
    return {
      name,
      header,
      total: whole ? whole.e.r + 1 : 0,
      columns: whole ? whole.e.c + 1 : 0,
      rows,
    };
  });
}

type Entry = { path: string; parts: string[]; folder: boolean; size: number };

async function expandedSize(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return 0;
  const { unzipSync } = await import('fflate');
  let total = 0;
  unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      return false;
    },
  });
  return total;
}

async function readArchive(buffer: ArrayBuffer) {
  const { unzipSync } = await import('fflate');
  const files: Entry[] = [];
  const entry = (path: string, folder: boolean, size: number) => ({
    path,
    parts: path.replace(/\/$/, '').split('/', 32),
    folder,
    size,
  });
  unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (files.length < 5_000 && !/(?:^|\/)(?:__MACOSX\/|\.DS_Store$)/.test(file.name))
        files.push(entry(file.name, file.name.endsWith('/'), file.originalSize));
      return false;
    },
  });
  const paths = new Set(files.map((file) => file.path));
  for (const file of files.slice()) {
    let prefix = '';
    for (const part of file.parts.slice(0, -1)) {
      prefix += `${part}/`;
      if (paths.has(prefix) || files.length >= 10_000) continue;
      paths.add(prefix);
      files.push(entry(prefix, true, 0));
    }
  }
  return files.sort((a, b) => {
    const left = a.parts;
    const right = b.parts;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index] === right[index]) continue;
      const leftFolder = index < left.length - 1 || a.folder;
      const rightFolder = index < right.length - 1 || b.folder;
      if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
      return left[index].localeCompare(right[index], undefined, { numeric: true });
    }
    return left.length - right.length;
  });
}

function ArchiveView({ entries }: { entries: Entry[] }) {
  return (
    <div className="artifact-archive" tabIndex={0} data-artifact-scroll="">
      <ul>
        {entries.map((entry) => {
          const parts = entry.parts;
          const name = parts[parts.length - 1];
          return (
            <li key={entry.path} style={{ paddingLeft: `${12 + (parts.length - 1) * 20}px` }}>
              {entry.folder ? (
                <Folder size={16} aria-hidden="true" />
              ) : (
                <FileGlyph name={name} mimeType="" />
              )}
              <span className="artifact-archive-name">{name}</span>
              {!entry.folder && (
                <span className="artifact-archive-size">{fileSize(entry.size)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MarkdownView({ text }: { text: string }) {
  return (
    <div className="artifact-prose" tabIndex={0} data-artifact-scroll="">
      <article>
        <Markdown
          remarkPlugins={[remarkGfm, remarkLinkDestinations]}
          skipHtml
          components={{
            a: ({ href, children }) => {
              const link = safeMessageLink(href ?? '', window.location.origin);
              return link ? (
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              );
            },
            img: ({ alt }) => <span>{alt || 'Image'}</span>,
            pre: ({ children }) => {
              const code = children as ReactElement<{ className?: string; children?: ReactNode }>;
              const language = /language-([\w+-]+)/.exec(code?.props?.className ?? '')?.[1];
              return (
                <CodeView
                  text={String(code?.props?.children ?? '')}
                  language={language ? codeLanguage(language) : null}
                  numbers={false}
                />
              );
            },
            table: ({ children }) => (
              <div className="artifact-prose-table">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {text}
        </Markdown>
      </article>
    </div>
  );
}

function DocumentView({
  buffer,
  name,
  stage,
  onDetail,
  onError,
}: {
  buffer: ArrayBuffer;
  name: string;
  stage: string;
  onDetail(detail: string): void;
  onError(): void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void documentHtml(buffer)
      .then(({ html, words }) => {
        if (!active) return;
        setHtml(html);
        onDetail(`${formatNumber(words)} ${words === 1 ? 'word' : 'words'}`);
      })
      .catch(() => {
        if (active) onError();
      });
    return () => {
      active = false;
    };
  }, [buffer, onDetail, onError]);
  const page = useMemo(() => (html === null ? null : documentFrame(html, stage)), [html, stage]);
  return page === null ? (
    <PreviewLoading />
  ) : (
    <SandboxedFrame html={page} title={name} onLeave={onError} />
  );
}

export default function AttachmentData({
  item,
  kind,
  mode,
  stage,
  onDetail,
}: {
  item: ImagePreview;
  kind: DataKind;
  mode: 'preview' | 'code';
  stage: string;
  onDetail(detail: string): void;
}) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [content, setContent] = useState<
    | { kind: 'text'; text: string }
    | { kind: 'sheets'; sheets: Sheet[] }
    | { kind: 'archive'; entries: Entry[] }
    | null
  >(null);
  const [error, setError] = useState(false);
  const [left, setLeft] = useState(false);
  const fail = useCallback(() => setError(true), []);
  useEffect(() => {
    const controller = new AbortController();
    setBuffer(null);
    setContent(null);
    setError(false);
    setLeft(false);
    if (item.size > limits[kind]) {
      setError(true);
      return () => controller.abort();
    }
    void (async () => {
      try {
        const response = await fetch(item.url, {
          signal: controller.signal,
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('File unavailable');
        const data = await response.arrayBuffer();
        if (data.byteLength > limits[kind]) throw new Error('File too large');
        if (
          ['spreadsheet', 'document', 'presentation'].includes(kind) &&
          (await expandedSize(data)) > 200_000_000
        )
          throw new Error('File too large');
        const next =
          kind === 'spreadsheet'
            ? { kind: 'sheets' as const, sheets: await readWorkbook(data) }
            : kind === 'archive'
              ? { kind: 'archive' as const, entries: await readArchive(data) }
              : kind === 'document' || kind === 'presentation'
                ? null
                : { kind: 'text' as const, text: new TextDecoder().decode(data) };
        if (controller.signal.aborted) return;
        setBuffer(data);
        setContent(next);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [item.url, item.size, kind]);
  const text = content?.kind === 'text' ? content.text : null;
  const csv = useMemo(() => {
    if (kind !== 'csv' || text === null) return null;
    try {
      const { rows, total } = parseCsv(text, csvDelimiter(text, item.name, item.mimeType ?? ''));
      return [
        {
          name: item.name,
          rows,
          header: true,
          total,
          columns: Math.max(0, ...rows.map((row) => row.length)),
        },
      ];
    } catch {
      return null;
    }
  }, [kind, text, item.name, item.mimeType]);
  const language = kind === 'html' ? 'html' : codeLanguage(item.name);
  const source = useMemo(
    () =>
      text !== null && language === 'json' && !/\.(?:jsonl|ndjson)$/i.test(item.name)
        ? formatJson(text)
        : text,
    [text, language, item.name],
  );
  useEffect(() => {
    if (content?.kind === 'archive') {
      const files = content.entries.filter((entry) => !entry.folder);
      onDetail(`${formatNumber(files.length)} ${files.length === 1 ? 'file' : 'files'}`);
    } else if (source !== null && (kind === 'text' || mode === 'code')) {
      const lines = source.replace(/\r?\n$/, '').split('\n').length;
      onDetail(`${formatNumber(lines)} ${lines === 1 ? 'line' : 'lines'}`);
    } else if (source !== null && kind === 'markdown') {
      const words = source.split(/\s+/).filter(Boolean).length;
      onDetail(`${formatNumber(words)} ${words === 1 ? 'word' : 'words'}`);
    } else if (kind === 'html') onDetail('');
  }, [content, source, kind, mode, onDetail]);
  const frame = useMemo(
    () => (kind === 'html' && text !== null ? sandboxedDocument(text, escapeForwarder) : null),
    [kind, text],
  );
  if (error || left || (kind === 'csv' && text !== null && !csv && mode === 'preview'))
    return (
      <PreviewUnavailable
        item={item}
        message={
          left
            ? 'This page tried to open a website'
            : item.size > limits[kind]
              ? 'This file is too large to preview'
              : undefined
        }
      />
    );
  if (!buffer) return <PreviewLoading />;
  if (kind === 'document')
    return (
      <DocumentView
        buffer={buffer}
        name={item.name}
        stage={stage}
        onDetail={onDetail}
        onError={fail}
      />
    );
  if (kind === 'presentation')
    return <SlidesView buffer={buffer} onDetail={onDetail} onError={fail} />;
  if (content?.kind === 'sheets') return <SheetView sheets={content.sheets} onDetail={onDetail} />;
  if (content?.kind === 'archive')
    return content.entries.length ? (
      <ArchiveView entries={content.entries} />
    ) : (
      <PreviewUnavailable item={item} message="This archive is empty" />
    );
  if (source === null) return <PreviewLoading />;
  if (!source.trim())
    return (
      <div className="artifact-empty" role="status">
        <FileText size={32} aria-hidden="true" />
        This file is empty.
      </div>
    );
  if (kind === 'n8n-workflow' && mode === 'preview')
    return (
      <Suspense fallback={<PreviewLoading />}>
        <WorkflowCanvas
          text={source}
          onDetail={onDetail}
          fallback={<PreviewUnavailable item={item} />}
        />
      </Suspense>
    );
  if (mode === 'code' || kind === 'text')
    return (
      <CodeView
        text={source}
        language={kind === 'markdown' || kind === 'csv' ? null : language}
        wrap={kind === 'markdown' || (kind === 'text' && !language)}
      />
    );
  if (kind === 'markdown') return <MarkdownView text={source} />;
  if (kind === 'html' && frame)
    return <SandboxedFrame html={frame} title={item.name} scripts onLeave={() => setLeft(true)} />;
  if (csv) return <SheetView sheets={csv} onDetail={onDetail} />;
  return <PreviewUnavailable item={item} />;
}
