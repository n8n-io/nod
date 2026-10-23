import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Root as HtmlRoot } from 'hast';
import type { BlockContent, PhrasingContent, Root, RootContent } from 'mdast';
import { LinkifyIt } from 'linkify-it';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import remarkInlineLinks from 'remark-inline-links';
import { SKIP, visit } from 'unist-util-visit';
import { rehypeLocalLinks } from './markdown';
import { safeMessageLink } from './message-links';

const markdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkInlineLinks)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '*',
    fences: true,
    listItemIndent: 'one',
  });
const linkify = new LinkifyIt({ fuzzyLink: true });

function literal(value: string): PhrasingContent[] {
  if (!value.startsWith('/') && safeMessageLink(value, window.location.origin))
    return [{ type: 'link', url: value, children: [{ type: 'text', value }] }];
  const local = (value: string): PhrasingContent[] => {
    const tree: HtmlRoot = { type: 'root', children: [{ type: 'text', value }] };
    rehypeLocalLinks()(tree);
    return tree.children.map((node) =>
      node.type === 'element' && typeof node.properties.href === 'string'
        ? {
            type: 'link',
            url: node.properties.href,
            children: [{ type: 'text', value: node.properties.href }],
          }
        : { type: 'text', value: 'value' in node ? String(node.value) : '' },
    );
  };
  const result: PhrasingContent[] = [];
  let offset = 0;
  for (const link of linkify.match(value) ?? []) {
    if (!safeMessageLink(link.url, window.location.origin)) continue;
    result.push(...local(value.slice(offset, link.index)));
    result.push({ type: 'link', url: link.url, children: [{ type: 'text', value: link.raw }] });
    offset = link.lastIndex;
  }
  result.push(...local(value.slice(offset)));
  return result;
}

function inline(nodes: JSONContent[], linked = false): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const mark = node.marks?.[0];
    if (mark) {
      const span = [node];
      while (
        index + 1 < nodes.length &&
        JSON.stringify(nodes[index + 1].marks?.[0]) === JSON.stringify(mark)
      )
        span.push(nodes[++index]);
      if (mark.type === 'code') {
        result.push({ type: 'inlineCode', value: span.map((item) => item.text ?? '').join('') });
        continue;
      }
      const children = inline(
        span.map((item) => ({ ...item, marks: item.marks!.slice(1) })),
        linked || mark.type === 'link',
      );
      if (mark.type === 'link')
        result.push({
          type: 'link',
          url: mark.attrs?.href ?? '',
          title: mark.attrs?.title,
          children,
        });
      else if (mark.type === 'bold') result.push({ type: 'strong', children });
      else if (mark.type === 'italic') result.push({ type: 'emphasis', children });
      else if (mark.type === 'strike') result.push({ type: 'delete', children });
      else if (mark.type === 'underline')
        result.push({ type: 'html', value: '<u>' }, ...children, { type: 'html', value: '</u>' });
      else result.push(...children);
    } else if (node.type === 'hardBreak') result.push({ type: 'break' });
    else if (node.type === 'text')
      result.push(
        ...(linked
          ? [{ type: 'text' as const, value: node.text ?? '' }]
          : literal(node.text ?? '')),
      );
    else result.push(...inline(node.content ?? [], linked));
  }
  return result;
}

function blocks(nodes: JSONContent[]): RootContent[] {
  return nodes.flatMap((node): RootContent[] => {
    const content = node.content ?? [];
    switch (node.type) {
      case 'paragraph':
        return [{ type: 'paragraph', children: inline(content) }];
      case 'heading':
        return [{ type: 'heading', depth: node.attrs?.level ?? 1, children: inline(content) }];
      case 'blockquote':
        return [{ type: 'blockquote', children: blocks(content) as BlockContent[] }];
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return [
          {
            type: 'list',
            ordered: node.type === 'orderedList',
            start: node.type === 'orderedList' ? (node.attrs?.start ?? 1) : undefined,
            spread: false,
            children: content.map((item) => ({
              type: 'listItem',
              checked: item.type === 'taskItem' ? Boolean(item.attrs?.checked) : null,
              spread: false,
              children: blocks(item.content ?? []) as BlockContent[],
            })),
          },
        ];
      case 'codeBlock':
        return [
          {
            type: 'code',
            lang: node.attrs?.language,
            value: content.map((n) => n.text ?? '').join(''),
          },
        ];
      case 'horizontalRule':
        return [{ type: 'thematicBreak' }];
      case 'table':
        return [
          {
            type: 'table',
            children: content.map((row) => ({
              type: 'tableRow',
              children: (row.content ?? []).map((cell) => ({
                type: 'tableCell',
                children: tableInline(
                  (cell.content ?? []).flatMap((paragraph, index) => [
                    ...(index ? [{ type: 'break' as const }] : []),
                    ...inline(paragraph.content ?? []),
                  ]),
                ),
              })),
            })),
          },
        ];
      default:
        return blocks(content);
    }
  });
}

function tableInline(nodes: PhrasingContent[]): PhrasingContent[] {
  return nodes.map((node) =>
    node.type === 'break'
      ? { type: 'html', value: '<br>' }
      : 'children' in node
        ? { ...node, children: tableInline(node.children) }
        : node,
  );
}

export function composerMarkdown(document: ProseMirrorNode) {
  const tree: Root = { type: 'root', children: blocks(document.toJSON().content ?? []) };
  return markdown.stringify(tree).replace(/\n$/, '');
}

function text(value: string, marks: JSONContent['marks'] = []): JSONContent[] {
  return value
    .split('\n')
    .flatMap((line, index) => [
      ...(index ? [{ type: 'hardBreak' }] : []),
      ...(line ? [{ type: 'text', text: line, ...(marks.length ? { marks } : {}) }] : []),
    ]);
}

function readInline(
  nodes: PhrasingContent[],
  marks: NonNullable<JSONContent['marks']> = [],
): JSONContent[] {
  const result: JSONContent[] = [];
  let underline = 0;
  let closing = nodes.filter((node) => node.type === 'html' && node.value === '</u>').length;
  for (const node of nodes) {
    if (node.type === 'html' && node.value === '<u>' && closing > 0) {
      underline++;
      continue;
    }
    if (node.type === 'html' && node.value === '</u>' && underline) {
      underline--;
      closing--;
      continue;
    }
    const active = underline ? [...marks, { type: 'underline' }] : marks;
    if (
      node.type === 'break' ||
      (node.type === 'html' && ['<br>', '<br/>', '<br />'].includes(node.value))
    )
      result.push({ type: 'hardBreak' });
    else if (node.type === 'text' || node.type === 'html') result.push(...text(node.value, active));
    else if (node.type === 'inlineCode')
      result.push({ type: 'text', text: node.value, marks: [...active, { type: 'code' }] });
    else if (node.type === 'link')
      result.push(
        ...readInline(node.children, [
          ...active,
          { type: 'link', attrs: { href: node.url, title: node.title } },
        ]),
      );
    else if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete')
      result.push(
        ...readInline(node.children, [
          ...active,
          { type: { strong: 'bold', emphasis: 'italic', delete: 'strike' }[node.type] },
        ]),
      );
    else
      result.push(
        ...text(
          markdown
            .stringify({ type: 'root', children: [{ type: 'paragraph', children: [node] }] })
            .trim(),
          active,
        ),
      );
  }
  return result;
}

function readBlocks(nodes: RootContent[]): JSONContent[] {
  return nodes.flatMap((node): JSONContent[] => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        return [
          {
            type: node.type,
            ...(node.type === 'heading' ? { attrs: { level: node.depth } } : {}),
            content: readInline(node.children),
          },
        ];
      case 'blockquote':
        return [{ type: 'blockquote', content: readBlocks(node.children) }];
      case 'code':
        return [
          {
            type: 'codeBlock',
            attrs: { language: node.lang ?? null },
            content: node.value ? [{ type: 'text', text: node.value }] : [],
          },
        ];
      case 'thematicBreak':
        return [{ type: 'horizontalRule' }];
      case 'list': {
        const lists: JSONContent[] = [];
        node.children.forEach((item, index) => {
          const task = typeof item.checked === 'boolean';
          const type = task ? 'taskList' : node.ordered ? 'orderedList' : 'bulletList';
          let list = lists.at(-1);
          if (list?.type !== type) {
            list = {
              type,
              ...(node.ordered ? { attrs: { start: (node.start ?? 1) + index } } : {}),
              content: [],
            };
            lists.push(list);
          }
          list.content!.push({
            type: task ? 'taskItem' : 'listItem',
            ...(task ? { attrs: { checked: item.checked } } : {}),
            content: readBlocks(item.children),
          });
        });
        return lists;
      }
      case 'table':
        return [
          {
            type: 'table',
            content: node.children.map((row, index) => ({
              type: 'tableRow',
              content: row.children.map((cell) => ({
                type: index ? 'tableCell' : 'tableHeader',
                content: [{ type: 'paragraph', content: readInline(cell.children) }],
              })),
            })),
          },
        ];
      case 'html':
        return [{ type: 'paragraph', content: text(node.value) }];
      case 'definition':
        return [];
      default:
        return [
          {
            type: 'paragraph',
            content: text(markdown.stringify({ type: 'root', children: [node] }).trim()),
          },
        ];
    }
  });
}

export function parseComposerMarkdown(value: string): JSONContent {
  if (!value.startsWith('/') && safeMessageLink(value, window.location.origin))
    return { type: 'doc', content: readBlocks([{ type: 'paragraph', children: literal(value) }]) };
  let parsed = markdown.parse(value);
  const protectedRanges: [number, number][] = [];
  visit(parsed, (node) => {
    if (
      [
        'code',
        'inlineCode',
        'link',
        'linkReference',
        'image',
        'imageReference',
        'html',
        'definition',
      ].includes(node.type)
    ) {
      if (node.position)
        protectedRanges.push([node.position.start.offset!, node.position.end.offset!]);
      return SKIP;
    }
  });
  let offset = 0;
  let source = '';
  for (const link of linkify.match(value) ?? []) {
    if (
      !safeMessageLink(link.raw, window.location.origin) ||
      protectedRanges.some(([start, end]) => link.index < end && link.lastIndex > start)
    )
      continue;
    source += value.slice(offset, link.index) + '<' + link.raw + '>';
    offset = link.lastIndex;
  }
  if (offset) parsed = markdown.parse(source + value.slice(offset));
  const tree = markdown.runSync(parsed) as Root;
  return { type: 'doc', content: readBlocks(tree.children) };
}
