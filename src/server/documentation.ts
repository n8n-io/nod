import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Documentation } from '../ports/agent.ts';

const parser = unified().use(remarkParse);
const site = 'https://nod.n8n.io/docs/';
const readSize = 8000;
const stopWords = new Set(
  'a about an and are be can do does for from how i in is it its me my of on or that the this to what when where which why with you your'.split(
    ' ',
  ),
);

function tokens(text: string) {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const phrase = (text: string) => tokens(text).join(' ');

function words(text: string) {
  return tokens(text).filter((word) => !stopWords.has(word));
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
      const content = source.slice(frontmatter?.[0].length ?? 0).trim();
      const nodes = parser.parse(content).children;
      const contentStart =
        nodes.find(
          (node) =>
            node.type !== 'paragraph' ||
            !/^import\s/.test(content.slice(node.position!.start.offset!)),
        )?.position!.start.offset ?? content.length;
      const body = content.slice(contentStart);
      const path = relative(root, file)
        .replaceAll('\\', '/')
        .replace(/\.mdx?$/, '')
        .replace(/(^|\/)index$/, '')
        .replace(/\/$/, '');
      const url = `${site}${path ? `${path}/` : ''}`;
      const headings = nodes.filter((node) => node.type === 'heading');
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
            offset: node.position!.start.offset! - contentStart,
            heading,
            anchor,
          };
        }),
      ];
      for (const [index, start] of starts.entries()) {
        const end = starts[index + 1]?.offset ?? body.length;
        const content = body.slice(start.offset, end).trim();
        if (!content) continue;
        const id = `${path || 'index'}${start.anchor ? `#${start.anchor}` : ''}`;
        const visible = nodes
          .filter((node) => {
            const offset = node.position!.start.offset! - contentStart;
            return offset >= start.offset && offset < end;
          })
          .map(text)
          .join(' ');
        const tokens = words(`${title} ${start.heading} ${visible}`);
        const terms = new Map<string, number>();
        for (const word of tokens) terms.set(word, (terms.get(word) ?? 0) + 1);
        const labels = new Set(words(`${title} ${start.heading}`));
        sections.push({
          id,
          title,
          heading: start.heading,
          url: `${url}${start.anchor ? `#${start.anchor}` : ''}`,
          content,
          terms,
          labels,
          titlePhrase: phrase(title),
          headingPhrase: phrase(start.heading),
          length: Math.max(1, tokens.length),
        });
      }
    }
    const frequencies = new Map<string, number>();
    for (const section of sections)
      for (const word of section.terms.keys())
        frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    const averageLength =
      sections.reduce((sum, section) => sum + section.length, 0) / Math.max(1, sections.length);
    return { sections, frequencies, averageLength };
  };
  let pending: ReturnType<typeof load> | undefined;
  const index = () =>
    (pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    }));
  return {
    async search(query) {
      const { sections, frequencies, averageLength } = await index();
      const terms = [...new Set(words(query))];
      const queryPhrase = phrase(query);
      const weights = new Map(
        terms.map((word) => [
          word,
          Math.log(
            1 +
              (sections.length - (frequencies.get(word) ?? 0) + 0.5) /
                ((frequencies.get(word) ?? 0) + 0.5),
          ),
        ]),
      );
      return sections
        .map((section) => {
          return {
            section,
            priority:
              section.headingPhrase === queryPhrase
                ? 2
                : section.titlePhrase === queryPhrase
                  ? 1
                  : 0,
            score: terms.reduce((score, word) => {
              const frequency = section.terms.get(word) ?? 0;
              const normalized =
                (frequency * 2.2) /
                (frequency + 1.2 * (0.25 + (0.75 * section.length) / averageLength));
              return score + weights.get(word)! * normalized * (section.labels.has(word) ? 2 : 1);
            }, 0),
          };
        })
        .filter(({ score, priority }) => score > 0 || priority > 0)
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            b.score - a.score ||
            a.section.id.localeCompare(b.section.id),
        )
        .slice(0, 5)
        .map(({ section }) => {
          const { id, title, heading, url, content } = section;
          return { id, title, heading, url, excerpt: content.slice(0, 400) };
        });
    },
    async read(id, offset = 0) {
      const section = (await index()).sections.find((section) => section.id === id);
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
