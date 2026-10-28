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

function htmlText(node: DefaultTreeAdapterMap['node']): string {
  const pending = [node];
  let text = '';
  let visited = 0;
  while (pending.length && text.length < 1000 && visited++ < 20000) {
    const current = pending.pop()!;
    if ('tagName' in current && ['script', 'style', 'template'].includes(current.tagName)) continue;
    const value =
      'value' in current
        ? current.value
        : 'tagName' in current && current.tagName === 'img'
          ? current.attrs.find((attribute) => attribute.name === 'alt')?.value || 'Image'
          : '';
    text += value.slice(0, 1000 - text.length);
    if ('childNodes' in current)
      for (let index = current.childNodes.length - 1; index >= 0; index--)
        pending.push(current.childNodes[index]);
  }
  return text;
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
      node.value = node.value.slice(0, remaining);
      remaining -= node.value.length;
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
  let fallback = plain.slice(0, 1000).trimEnd();
  for (;;) {
    const value = markdown
      .stringify({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: fallback }] }],
      })
      .trimEnd();
    if (value.length <= 4000) return value;
    fallback = fallback.slice(0, Math.floor(fallback.length / 2));
  }
}
