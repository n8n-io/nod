import { areaLabels, memoryAreas, noteChars, type MemoryArea } from '../../shared/memory';

export const memoryImportPrompt = `I'm moving to a new assistant. List everything you know about me: your saved memories, my custom instructions and what you learned about me in our chats. Keep my own words where you can.

Write one fact per line, starting with "- ", under the heading that fits best:

${(['about', 'preferences', 'people', 'routines'] as const).map((area) => `## ${areaLabels[area]}`).join('\n')}

Leave out passwords, codes, and card or account numbers. Reply with one code block and nothing else.`;

const headings = new Map<string, MemoryArea>(
  memoryAreas.flatMap((area) => [
    [area, area],
    [areaLabels[area].toLowerCase(), area],
  ]),
);

export type ImportedNote = { area: MemoryArea; text: string };

export function parseMemoryImport(text: string): ImportedNote[] {
  let area: MemoryArea = 'about';
  const rows = text.split(/\r?\n/).flatMap((row) => {
    const heading = /^#{1,6}\s+(.+?)[\s:#]*$/.exec(row);
    if (heading) {
      area = headings.get(heading[1]!.toLowerCase()) ?? 'about';
      return [];
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*\S)/.exec(row);
    const line = (bullet?.[1] ?? row).replace(/\s+/g, ' ').trim();
    return line && !line.startsWith('```') && line.length <= noteChars
      ? [{ area, text: line, bullet: !!bullet }]
      : [];
  });
  const bullets = rows.some((row) => row.bullet);
  return rows.flatMap(({ bullet, ...note }) => (bullet || !bullets ? [note] : []));
}
