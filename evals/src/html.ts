import { parse } from 'parse5';

type Node = { nodeName: string; value?: string; childNodes?: Node[] };

const inline = new Set(
  'a abbr b cite code em i kbd label mark q s small span strong sub sup time u var'.split(' '),
);

export function pageText(html: string) {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeName === 'style' || node.nodeName === 'script') return;
    if (node.nodeName === '#text') return void parts.push(node.value ?? '');
    const block = !inline.has(node.nodeName);
    if (block) parts.push(' ');
    for (const child of node.childNodes ?? []) walk(child);
    if (block) parts.push(' ');
  };
  walk(parse(html) as Node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
