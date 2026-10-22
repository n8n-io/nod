import {
  areaLabels,
  memoryAreas,
  type MemoryArchived,
  type MemoryNote,
  type MemoryStatus,
  type MemoryView,
} from './memory.ts';

const statuses: Array<{ status: MemoryStatus; label: string; meaning: string }> = [
  {
    status: 'stated',
    label: 'Confirmed',
    meaning: 'You said it, wrote it or confirmed it. nod uses it.',
  },
  {
    status: 'observed',
    label: 'Learned',
    meaning: 'nod heard it in two or more of your messages. nod uses it.',
  },
  {
    status: 'tentative',
    label: 'Mentioned once',
    meaning: 'nod heard it once. It is a guess until you confirm it or say it again.',
  },
];
const reasons: Record<MemoryArchived['reason'], string> = {
  superseded: 'Replaced',
  merged: 'Merged',
  duplicate: 'Duplicate',
  expired: 'Expired',
  stale: 'Not mentioned again',
  obsolete: 'No longer true',
  contradicted: 'Contradicted',
};
const channels: Record<string, string> = {
  web: 'nod web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const day = (value: string) => value.slice(0, 10);
const text = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|~#]/g, '\\$&');

function note(entry: MemoryNote) {
  return [
    `- ${text(entry.text)}${entry.expires ? ` (until ${entry.expires})` : ''}`,
    ...entry.sources.flatMap((source) =>
      source.text && source.at
        ? [
            `  - “${text(source.text)}” (${channels[source.channel ?? 'web'] ?? source.channel}, ${day(source.at)})`,
          ]
        : [],
    ),
    ...(entry.edited
      ? [`  - ${entry.sources.length ? 'Updated' : 'Written'} by you on ${day(entry.edited)}`]
      : []),
  ].join('\n');
}

export function memoryFileName(exported: Date) {
  return `nod-memory-${day(exported.toISOString())}.md`;
}

export function memoryMarkdown(view: MemoryView, exported: Date) {
  const sections = statuses.flatMap(({ status, label }) => {
    const notes = view.notes.filter((entry) => entry.status === status);
    if (!notes.length) return [];
    const groups = memoryAreas.flatMap((area) => {
      const group = notes.filter((entry) => entry.area === area);
      return group.length ? [`### ${areaLabels[area]}\n\n${group.map(note).join('\n')}`] : [];
    });
    return [`## ${label}\n\n${groups.join('\n\n')}`];
  });
  return `${[
    '# What nod remembers about you',
    `Exported on ${day(exported.toISOString())}.`,
    'nod keeps short notes about you so it does not have to ask twice. Each note has a status:',
    [
      ...statuses.map(({ label, meaning }) => `- **${label}**: ${meaning}`),
      '- **Let go**: Replaced, expired or not mentioned for 60 days. Kept so you can bring it back.',
    ].join('\n'),
    `Saving new notes is ${view.saving ? 'on' : 'off'}. Sensitive topics (health, religion, politics and similar) are ${view.sensitive ? 'remembered' : 'learned only when you ask'}.`,
    ...sections,
    ...(view.archive.length
      ? [
          `## Let go\n\n${view.archive
            .map(
              (item) =>
                `- ~~${text(item.text)}~~ ${reasons[item.reason]} on ${day(item.archived)}.`,
            )
            .join('\n')}`,
        ]
      : []),
    ...(view.skills.length
      ? [
          `## Skills nod learned\n\nHow nod did a task, written by nod so it can follow the same steps next time.\n\n${view.skills
            .map(
              (skill) =>
                `### ${text(skill.name)}\n\n${text(skill.description)} Updated on ${day(skill.updated)}.\n\n${skill.body
                  .split('\n')
                  .map((row) => `    ${row}`)
                  .join('\n')}`,
            )
            .join('\n\n')}`,
        ]
      : []),
    ...(view.notes.length || view.skills.length ? [] : ['Nothing yet.']),
  ].join('\n\n')}\n`;
}
