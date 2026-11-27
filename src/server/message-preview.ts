import type { Nodes, Root } from 'mdast';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
  bullet: '-',
  emphasis: '*',
  fences: true,
});

function previewSlice(value: string, length: number): string {
  let end = Math.min(length, value.length);
  if (
    (value.charCodeAt(end - 1) & 0xfc00) === 0xd800 &&
    (value.charCodeAt(end) & 0xfc00) === 0xdc00
  )
    end--;
  return value.slice(0, end);
}

const htmlBlocks = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

function htmlText(node: DefaultTreeAdapterMap['node']): string {
  const pending: Array<DefaultTreeAdapterMap['node'] | null> = [node];
  let text = '';
  let remaining = 1000;
  let visited = 0;
  const append = (value: string) => {
    text += previewSlice(value, remaining);
    remaining -= Math.min(value.length, remaining);
  };
  const separate = () => {
    if (text && !/\s$/.test(text)) append(' ');
  };
  while (pending.length && remaining > 0 && visited < 20000) {
    const current = pending.pop();
    if (!current) {
      separate();
      continue;
    }
    visited++;
    if ('tagName' in current && ['script', 'style', 'template'].includes(current.tagName)) continue;
    if ('tagName' in current && htmlBlocks.has(current.tagName)) {
      separate();
      pending.push(null);
    }
    if ('value' in current) append(current.value);
    else if ('tagName' in current && current.tagName === 'img')
      append(current.attrs.find((attribute) => attribute.name === 'alt')?.value || 'Image');
    if ('childNodes' in current)
      for (let index = current.childNodes.length - 1; index >= 0; index--)
        pending.push(current.childNodes[index]);
  }
  return text.trimEnd();
}

function urlHost(url: string): string {
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).hostname;
  } catch {
    return '';
  }
}

export function plainPreview(text: string): string {
  const parts: string[] = [];
  let remaining = 1000;
  let nodes = 4096;
  const add = (value: string) => {
    const piece = previewSlice(value, remaining);
    parts.push(piece);
    remaining -= piece.length;
  };
  function walk(node: Nodes, block = true) {
    if (remaining <= 0 || nodes-- <= 0) return;
    if (node.type === 'code' || node.type === 'definition' || node.type === 'footnoteDefinition')
      return;
    if (node.type === 'html') {
      add(/^<br\s*\/?>$/i.test(node.value.trim()) ? ' ' : htmlText(parseFragment(node.value)));
      if (block) add(' ');
      return;
    }
    if (node.type === 'image' || node.type === 'imageReference') return add(node.alt || '');
    if (node.type === 'break') return add(' ');
    if (node.type === 'link') {
      const [label, ...rest] = node.children;
      if (!rest.length && label?.type === 'text' && label.value === node.url)
        return add(urlHost(node.url) || label.value);
    }
    if ('value' in node) add(node.value);
    if ('children' in node) {
      const blocks = ['root', 'blockquote', 'list', 'listItem'].includes(node.type);
      for (const child of node.children) walk(child, blocks);
    }
    if (['paragraph', 'heading', 'listItem', 'tableCell'].includes(node.type)) add(' ');
  }
  let source = text;
  if (text.length > 2000) {
    const window = previewSlice(text, 2000);
    const block = window.lastIndexOf('\n\n');
    const space = window.search(/\s\S*$/);
    source = window.slice(0, block > 0 ? block : space > 0 ? space : window.length);
  }
  try {
    walk(markdown.parse(source));
  } catch {
    return '';
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function messagePreview(text: string): string {
  if (text.length <= 1000) return text;
  let remaining = 1000;
  let nodes = 2048;
  let plain = '';
  function trim(node: Nodes): Nodes[] {
    if (remaining <= 0 || nodes-- <= 0 || node.type === 'definition') return [];
    if (node.type === 'image' || node.type === 'imageReference')
      node = { type: 'text', value: node.alt || 'Image' };
    if (node.type === 'html' && node.value.length > remaining)
      node = { type: 'text', value: htmlText(parseFragment(node.value)) };
    if ('value' in node) {
      const value = previewSlice(node.value, remaining);
      remaining -= Math.min(node.value.length, remaining);
      node.value = value;
      plain += node.type === 'html' ? htmlText(parseFragment(node.value)) : node.value;
      if (node.type === 'code') {
        node.lang = null;
        node.meta = null;
      }
    }
    if ('children' in node) {
      node.children = node.children.flatMap(trim) as typeof node.children;
      if (['paragraph', 'heading', 'listItem', 'tableCell'].includes(node.type)) plain += ' ';
      if (node.type === 'link' || node.type === 'linkReference') return node.children;
      if (!node.children.length) return [];
    }
    return [node];
  }
  try {
    const tree = markdown.parse(text);
    tree.children = tree.children.flatMap(trim) as Root['children'];
    const result = markdown.stringify(tree).trimEnd();
    if (result.length <= 4000) return result;
  } catch {
    plain ||= text;
  }
  let fallback = previewSlice(plain, 1000).trimEnd();
  for (;;) {
    const value = markdown
      .stringify({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: fallback }] }],
      })
      .trimEnd();
    if (value.length <= 4000) return value;
    fallback = previewSlice(fallback, Math.floor(fallback.length / 2));
  }
}
