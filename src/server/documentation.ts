import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Documentation } from '../ports/agent.ts';

const parser = unified().use(remarkParse);
const site = 'https://nod.n8n.io/docs/';
const readSize = 8000;
const stopWords = new Set(
  'a about an and are be can do does for from how i in is it its me my nod of on or that the this to what when where which why with you your'.split(
    ' ',
  ),
);

function words(text: string) {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((word) => !stopWords.has(word));
}

function text(node: unknown): string {
  const value = node as { value?: string; children?: unknown[] };
  return value.value ?? value.children?.map(text).join('') ?? '';
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? files(path)
          : entry.isFile() && /\.mdx?$/.test(entry.name)
            ? [path]
            : [];
      }),
    )
  ).flat();
}

export function createDocumentation(root: string): Documentation {
  const load = async () => {
    const sections = [];
    for (const file of (await files(root)).sort()) {
      const source = await readFile(file, 'utf8');
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const title =
        frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2') ??
        basename(file);
      const body = source
        .slice(frontmatter?.[0].length ?? 0)
        .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        .trim();
      const path = relative(root, file)
        .replaceAll('\\', '/')
        .replace(/\.mdx?$/, '')
        .replace(/(^|\/)index$/, '')
        .replace(/\/$/, '');
      const url = `${site}${path ? `${path}/` : ''}`;
      const headings = parser.parse(body).children.filter((node) => node.type === 'heading');
      const anchors = new Set<string>();
      const starts = [
        { offset: 0, heading: title, anchor: '' },
        ...headings.map((node) => {
          const heading = text(node);
          const slug = heading
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/ /g, '-');
          let anchor = slug;
          for (let count = 1; anchors.has(anchor); count++) anchor = `${slug}-${count}`;
          anchors.add(anchor);
          return {
            offset: node.position!.start.offset!,
            heading,
            anchor,
          };
        }),
      ];
      for (const [index, start] of starts.entries()) {
        const content = body.slice(start.offset, starts[index + 1]?.offset).trim();
        if (!content) continue;
        const id = `${path || 'index'}${start.anchor ? `#${start.anchor}` : ''}`;
        const terms = new Set(words(`${title} ${start.heading} ${content}`));
        const labels = new Set(words(`${title} ${start.heading}`));
        sections.push({
          id,
          title,
          heading: start.heading,
          url: `${url}${start.anchor ? `#${start.anchor}` : ''}`,
          content,
          terms,
          labels,
        });
      }
    }
    return sections;
  };
  let pending: ReturnType<typeof load> | undefined;
  const index = () =>
    (pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    }));
  return {
    async search(query) {
      const sections = await index();
      const terms = [...new Set(words(query))];
      const weights = new Map(
        terms.map((word) => [
          word,
          Math.log(
            1 +
              sections.length / (1 + sections.filter((section) => section.terms.has(word)).length),
          ),
        ]),
      );
      return sections
        .map((section) => {
          const matched = terms.filter((word) => section.terms.has(word));
          return {
            section,
            score:
              matched.length *
              matched.reduce(
                (score, word) => score + weights.get(word)! * (section.labels.has(word) ? 2 : 1),
                0,
              ),
          };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
        .slice(0, 5)
        .map(({ section }) => {
          const { id, title, heading, url, content } = section;
          return { id, title, heading, url, excerpt: content.slice(0, 400) };
        });
    },
    async read(id, offset = 0) {
      const section = (await index()).find((section) => section.id === id);
      if (!section) throw new Error(`The Nod documentation section was not found: ${id}`);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= section.content.length)
        throw new Error('The Nod documentation offset is outside this section.');
      const { title, heading, url, content } = section;
      const end = Math.min(offset + readSize, content.length);
      return {
        id,
        title,
        heading,
        url,
        content: content.slice(offset, end),
        ...(end < content.length ? { nextOffset: end } : {}),
      };
    },
  };
}
