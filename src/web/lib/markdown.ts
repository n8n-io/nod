import type { Root, Text, Element } from 'hast';
import { SKIP, visit } from 'unist-util-visit';

function unlinkCode(node: Element) {
  node.children = node.children.flatMap((child) => {
    if (child.type !== 'element') return [child];
    unlinkCode(child);
    return child.tagName === 'a' ? child.children : [child];
  });
}

export function rehypeLocalLinks() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === 'element') {
        if (node.tagName === 'code' || node.tagName === 'pre') {
          unlinkCode(node);
          return SKIP;
        }
        if (['a', 'script', 'style', 'textarea', 'title'].includes(node.tagName)) return SKIP;
      }
      if (node.type !== 'text' || index === undefined || !parent) return;
      const parts: (Text | Element)[] = [];
      const pattern =
        /(?<![\w/:])\/(?:api\/artifacts|vault|credentials|browser-connect)\/[A-Za-z0-9_-]+(?:[?#][^\s<>"'\[\]()]+)?/g;
      let cursor = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > cursor)
          parts.push({ type: 'text', value: node.value.slice(cursor, match.index) });
        const destination = match[0].replace(/[.,;:!?]+$/, '');
        parts.push({
          type: 'element',
          tagName: 'a',
          properties: { href: destination },
          children: [{ type: 'text', value: destination }],
        });
        if (destination.length < match[0].length)
          parts.push({ type: 'text', value: match[0].slice(destination.length) });
        cursor = match.index + match[0].length;
      }
      if (!parts.length) return;
      if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
