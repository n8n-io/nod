import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, FileText } from 'lucide-react';
import { safeMessageLink } from '../lib/message-links';
import { formatNumber } from '../lib/date-format';

type Sheet = { name: string; rows: string[][]; header: boolean };
type Content =
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'spreadsheet'; sheets: Sheet[] };
const previewRows = 202;
const previewColumns = 100;
const previewCellLength = 10_000;

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

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cellStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      cellStarted = true;
      if (quoted && text[index + 1] === '"') {
        if (cell.length < previewCellLength) cell += '"';
        index += 1;
      } else if (!cell || quoted) quoted = !quoted;
      else if (cell.length < previewCellLength) cell += char;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      if (row.length < previewColumns) row.push(cell);
      cell = '';
      cellStarted = false;
      if (char !== ',') {
        rows.push(row);
        if (rows.length >= previewRows) return rows;
        row = [];
        if (char === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else {
      cellStarted = true;
      if (cell.length < previewCellLength) cell += char;
    }
  }
  if (quoted) throw new Error('Invalid CSV');
  if (row.length || cellStarted) rows.push([...row, cell].slice(0, previewColumns));
  return rows;
}

function Spreadsheet({ sheets }: { sheets: Sheet[] }) {
  const [selected, setSelected] = useState(0);
  const sheet = sheets[selected];
  const columns = Math.max(0, ...sheet.rows.map((row) => row.length));
  const headings = Array.from({ length: columns }, (_, index) =>
    sheet.header
      ? sheet.rows[0]?.[index] || `Column ${index + 1}`
      : (() => {
          let value = index + 1;
          let label = '';
          while (value > 0) {
            value -= 1;
            label = String.fromCharCode(65 + (value % 26)) + label;
            value = Math.floor(value / 26);
          }
          return label;
        })(),
  );
  const rows = sheet.header ? sheet.rows.slice(1) : sheet.rows;
  return (
    <>
      <div className="attachment-data-toolbar">
        {sheets.length > 1 && (
          <label>
            Sheet
            <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
              {sheets.map((item, index) => (
                <option value={index} key={`${item.name}:${index}`}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span>{formatNumber(rows.length)} rows</span>
      </div>
      <div className="attachment-table-scroll" role="region" aria-label="Spreadsheet" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {!sheet.header && <th aria-label="Row number" />}
              {headings.map((heading, index) => (
                <th key={index} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {!sheet.header && <th scope="row">{rowIndex + 1}</th>}
                {headings.map((_, columnIndex) => (
                  <td key={columnIndex}>
                    <SpreadsheetCell value={row[columnIndex] ?? ''} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && <p className="attachment-data-limit">Showing the first 200 rows.</p>}
    </>
  );
}

export default function AttachmentData({
  url,
  name,
  kind,
  size,
}: {
  url: string;
  name: string;
  kind: 'markdown' | 'text' | 'csv' | 'spreadsheet';
  size: number;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(false);
    if (size > 4_000_000) {
      setError(true);
      return () => controller.abort();
    }
    void (async () => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('File unavailable');
        const blob = await response.blob();
        if (blob.size > 4_000_000) throw new Error('File too large');
        let next: Content;
        if (kind === 'markdown' || kind === 'text') next = { kind, text: await blob.text() };
        else if (kind === 'csv')
          next = {
            kind: 'spreadsheet',
            sheets: [{ name, rows: parseCsv(await blob.text()), header: true }],
          };
        else {
          const { read, utils } = await import('@e965/xlsx');
          const workbook = read(await blob.arrayBuffer(), {
            type: 'array',
            cellText: true,
            sheetRows: previewRows,
          });
          next = {
            kind: 'spreadsheet',
            sheets: workbook.SheetNames.map((name) => {
              const sheet = workbook.Sheets[name];
              const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : null;
              if (
                range &&
                (!Number.isFinite(range.e.r) ||
                  !Number.isFinite(range.e.c) ||
                  range.e.r < 0 ||
                  range.e.c < 0)
              )
                throw new Error('Invalid spreadsheet range');
              return {
                name,
                header: false,
                rows: range
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
                  : [],
              };
            }),
          };
        }
        if (!controller.signal.aborted) setContent(next);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [url, name, kind, size]);

  return (
    <div className="attachment-data-preview" aria-busy={!content && !error}>
      <div className="attachment-data-heading">
        <FileText size={16} aria-hidden="true" />
        <strong>{name}</strong>
      </div>
      {error ? (
        <div className="attachment-preview-unavailable" role="status">
          <span>Preview unavailable</span>
          <a href={url} download={name}>
            Download
          </a>
        </div>
      ) : !content ? (
        <div className="attachment-data-loading" role="status">
          Loading preview…
        </div>
      ) : content.kind === 'text' ? (
        content.text ? (
          <pre
            className="attachment-plain-text"
            role="region"
            aria-label="Text preview"
            tabIndex={0}
          >
            {content.text}
          </pre>
        ) : (
          <div className="attachment-data-loading" role="status">
            This file is empty.
          </div>
        )
      ) : content.kind === 'markdown' ? (
        <div className="message-text attachment-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
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
            }}
          >
            {content.text}
          </Markdown>
        </div>
      ) : (
        <Spreadsheet sheets={content.sheets} />
      )}
    </div>
  );
}
