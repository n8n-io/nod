import { convertEmojiPlaceholders, parseMarkdown, walkAst, type Root } from 'chat';

type Node = Root | Root['children'][number];
type Parent = Extract<Node, { children: unknown }>;

interface Syntax {
  text(value: string): string;
  code(value: string): string;
  block(value: string, language?: string | null): string;
  link(label: string, url: string): string;
  bold: string;
  italic: string;
  strike: string;
  bullet: string;
  number(value: number): string;
  quote: string;
  literal: RegExp;
}

const telegram: Syntax = {
  text: (value) => value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&'),
  code: (value) => `\`${value.replace(/[`\\]/g, '\\$&')}\``,
  block: (value, language) =>
    `\`\`\`${language && /^[\w#+.-]+$/.test(language) ? language : ''}\n${value.replace(/[`\\]/g, '\\$&')}\n\`\`\``,
  link: (label, url) => `[${label}](${url.replace(/[)\\]/g, '\\$&')})`,
  bold: '*',
  italic: '_',
  strike: '~',
  bullet: '•',
  number: (value) => `${value}\\.`,
  quote: '>',
  literal: /(?<![\w@:/.~-])[\w~./-]*[\w-]\.(?:md|py|sh|java|zip|mov)(?![\w-]|\.\w)/gi,
};

const whatsapp: Syntax = {
  text: (value) => value,
  code: (value) => `\`${value}\``,
  block: (value) => `\`\`\`\n${value}\n\`\`\``,
  link: (label, url) => `${label} (${url})`,
  bold: '*',
  italic: '_',
  strike: '~',
  bullet: '-',
  number: (value) => `${value}.`,
  quote: '> ',
  literal: /(?<![\p{L}\p{N}])([*_~])(?=\S)[^\n`]*?(?<=\S)\1(?![\p{L}\p{N}])/gu,
};

function plain(node: Node): string {
  if ('value' in node) return String(node.value);
  return 'children' in node ? node.children.map((child) => plain(child as Node)).join('') : '';
}

function prose(value: string, syntax: Syntax) {
  let result = '';
  let last = 0;
  for (const match of value.matchAll(syntax.literal)) {
    result += syntax.text(value.slice(last, match.index)) + syntax.code(match[0]);
    last = match.index + match[0].length;
  }
  return result + syntax.text(value.slice(last));
}

function render(root: Root, syntax: Syntax, source?: string) {
  const inline = (nodes: Node[], open: ReadonlySet<string>) =>
    nodes.map((node) => phrase(node, open)).join('');

  const mark = (marker: string, node: Parent, open: ReadonlySet<string>) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (
      source !== undefined &&
      from !== undefined &&
      to !== undefined &&
      /[\p{L}\p{N}]/u.test(`${source[from - 1] ?? ''}${source[to] ?? ''}`)
    )
      return syntax.text(source.slice(from, to));
    const content = inline(node.children as Node[], new Set([...open, marker]));
    const core = content.trim();
    if (open.has(marker) || !core) return content;
    const start = content.indexOf(core);
    return `${content.slice(0, start)}${marker}${core}${marker}${content.slice(start + core.length)}`;
  };

  const phrase = (node: Node, open: ReadonlySet<string>): string => {
    switch (node.type) {
      case 'text':
        return open.has('link') ? syntax.text(node.value) : prose(node.value, syntax);
      case 'html':
        return syntax.text(node.value);
      case 'strong':
        return mark(syntax.bold, node, open);
      case 'emphasis':
        return mark(syntax.italic, node, open);
      case 'delete':
        return mark(syntax.strike, node, open);
      case 'inlineCode':
        return syntax.code(node.value);
      case 'break':
        return '\n';
      case 'link':
      case 'image': {
        const label = node.type === 'image' ? node.alt || 'Image' : plain(node);
        const rendered =
          node.type === 'image'
            ? syntax.text(label)
            : inline(node.children as Node[], new Set([...open, 'link']));
        if (
          !/^(?:https?|mailto|tel):/i.test(node.url) ||
          [label, `mailto:${label}`].includes(node.url)
        )
          return rendered;
        return syntax.link(rendered, node.url);
      }
      case 'footnoteReference':
        return syntax.text(`[${node.label ?? node.identifier}]`);
      default:
        return 'children' in node ? inline(node.children as Node[], open) : '';
    }
  };

  const none = new Set<string>();
  const blocks = (nodes: Node[], separator = '\n\n') =>
    nodes.map(block).filter(Boolean).join(separator);

  const block = (node: Node): string => {
    switch (node.type) {
      case 'paragraph':
        return inline(node.children, none);
      case 'heading':
        return mark(syntax.bold, node, none);
      case 'thematicBreak':
        return syntax.text('———');
      case 'code':
        return syntax.block(node.value, node.lang);
      case 'blockquote':
        return blocks(node.children)
          .split('\n')
          .map((line) =>
            `${syntax.quote}${line.startsWith(syntax.quote) ? line.slice(syntax.quote.length) : line}`.trimEnd(),
          )
          .join('\n');
      case 'list':
        return node.children
          .map((item, index) => {
            const box = item.checked === true ? '☑' : item.checked === false ? '☐' : '';
            const marker = node.ordered
              ? `${syntax.number((node.start ?? 1) + index)}${box && ` ${box}`}`
              : box || syntax.bullet;
            const content = blocks(item.children, item.spread ? '\n\n' : '\n')
              .split('\n')
              .map((line, position) => (position && line ? `  ${line}` : line))
              .join('\n');
            return `${marker} ${content}`;
          })
          .join('\n');
      case 'table': {
        const [head, ...rows] = node.children.map((row) => row.children);
        if (!head) return '';
        const labels = head.map((cell) => inline(cell.children, none).trim());
        if (!rows.length || labels.length < 2)
          return (rows.length ? rows.map((row) => row[0]) : head)
            .map((cell) => cell && inline(cell.children, none).trim())
            .filter(Boolean)
            .map((cell) => `${syntax.bullet} ${cell}`)
            .join('\n');
        return rows
          .map((row) =>
            [
              row[0] && mark(syntax.bold, row[0], none).trim(),
              ...row.slice(1).map((cell, index) => {
                const value = inline(cell.children, none).trim();
                const label = labels[index + 1];
                return value && `${syntax.bullet} ${label ? `${label}: ` : ''}${value}`;
              }),
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n');
      }
      case 'definition':
        return '';
      case 'footnoteDefinition':
        return `${syntax.text(`[${node.label ?? node.identifier}]`)} ${blocks(node.children, '\n')}`;
      default:
        return 'children' in node ? blocks(node.children as Node[]) : phrase(node, none);
    }
  };

  return blocks(root.children).trim();
}

export function telegramText(markdown: string | Root) {
  return typeof markdown === 'string'
    ? render(parseMarkdown(markdown), telegram, markdown)
    : render(markdown, telegram);
}

export function whatsappText(markdown: string) {
  return render(parseMarkdown(markdown), whatsapp, markdown);
}

export function hasLiteralBlock(markdown: string, literal: string) {
  const root = parseMarkdown(markdown);
  const blocks = root.children.filter((node) => node.type === 'code');
  let count = 0;
  walkAst(root, (node) => {
    if (node.type === 'code') count++;
    return node;
  });
  return count === 1 && blocks.length === 1 && blocks[0]!.value === literal;
}

export function canDeliverWhatsAppLiteral(markdown: string, literal: string) {
  const formatted = whatsappText(markdown);
  return (
    hasLiteralBlock(markdown, literal) &&
    formatted.split('```').length === 3 &&
    convertEmojiPlaceholders(formatted, 'whatsapp') === formatted &&
    splitText(formatted, whatsappTextLimit).length === 1
  );
}

export const whatsappTextLimit = 4096;

const fenceLine = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const closes = (line: string, marker: string) => {
  const closing = closingFence.exec(line)?.[1];
  return closing?.[0] === marker[0] && closing.length >= marker.length;
};

function openFence(text: string) {
  let open: { line: string; marker: string } | undefined;
  for (const line of text.split('\n')) {
    if (open && closes(line, open.marker)) open = undefined;
    else if (!open) {
      const marker = fenceLine.exec(line)?.[1];
      if (marker) open = { line, marker };
    }
  }
  return open;
}

export function splitText(text: string, limit: number) {
  const parts: string[] = [];
  let rest = text;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const cutAt = (room: number) => {
    const slice = rest.slice(0, room);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < room / 2) cut = slice.lastIndexOf('\n');
    if (cut < room / 2) cut = room;
    let boundary = 0;
    for (const { index, segment } of graphemes.segment(rest)) {
      if (index + segment.length > cut) break;
      boundary = index + segment.length;
    }
    cut = boundary || cut;
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    return cut;
  };
  while (rest.length > limit) {
    let cut = cutAt(limit);
    let fence = openFence(rest.slice(0, cut));
    if (fence && cut + fence.marker.length + 1 > limit) {
      cut = cutAt(limit - fence.marker.length - 1);
      fence = openFence(rest.slice(0, cut));
    }
    if (fence && cut > fence.line.length + 1) {
      const tail = rest.slice(cut).replace(/^\n+/, '');
      const next = tail.split('\n', 1)[0]!;
      parts.push(`${rest.slice(0, cut).trimEnd()}\n${fence.marker}`);
      rest = closes(next, fence.marker)
        ? tail.slice(next.length).trimStart()
        : `${fence.line}\n${tail}`;
    } else {
      parts.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
  }
  return rest ? [...parts, rest] : parts;
}
