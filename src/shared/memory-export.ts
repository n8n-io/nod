import {
  memoryAreas,
  type MemoryArchived,
  type MemoryArea,
  type MemoryNote,
  type MemoryStatus,
  type MemoryView,
} from './memory.ts';

const areaLabels: Record<MemoryArea, string> = {
  about: 'About you',
  preferences: 'Preferences',
  people: 'People',
  routines: 'Routines',
  lessons: 'Lessons',
};
const statuses: Array<{ status: MemoryStatus; label: string; meaning: string }> = [
  {
    status: 'stated',
    label: 'Confirmed',
    meaning: 'You said it, wrote it or confirmed it. Otto uses it.',
  },
  {
    status: 'observed',
    label: 'Learned',
    meaning: 'Otto heard it in two or more of your messages. Otto uses it.',
  },
  {
    status: 'tentative',
    label: 'Mentioned once',
    meaning: 'Otto heard it once. It is a guess until you confirm it or say it again.',
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
  web: 'Otto web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};
const profileLabels = {
  name: 'Name',
  location: 'Location',
  phone: 'Phone',
  preferences: 'Preferences',
} as const;

const day = (value: string) => value.slice(0, 10);
const text = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|~#]/g, '\\$&');

function profile(view: MemoryView) {
  return (Object.keys(profileLabels) as Array<keyof typeof profileLabels>)
    .filter((field) => view.profile[field])
    .map((field) => `${profileLabels[field]}: ${text(view.profile[field])}`);
}

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
  return `otto-memory-${day(exported.toISOString())}.md`;
}

export function memoryMarkdown(view: MemoryView, exported: Date) {
  const saved = profile(view);
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
    '# What Otto remembers about you',
    `Exported on ${day(exported.toISOString())}.`,
    'Otto keeps short notes about you so it does not have to ask twice. Each note has a status:',
    [
      ...statuses.map(({ label, meaning }) => `- **${label}**: ${meaning}`),
      '- **Let go**: Replaced, expired or not mentioned for 60 days. Kept so you can bring it back.',
    ].join('\n'),
    `Saving new notes is ${view.saving ? 'on' : 'off'}. Sensitive topics (health, religion, politics and similar) are ${view.sensitive ? 'remembered' : 'learned only when you ask'}.`,
    ...(saved.length ? [`## Profile\n\n${saved.map((line) => `- ${line}`).join('\n')}`] : []),
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
    ...(view.notes.length || saved.length ? [] : ['Nothing yet.']),
  ].join('\n\n')}\n`;
}

export function memoryDigest(view: MemoryView, link: string | null, limit = 3800) {
  const lines = ['**What Otto remembers about you**'];
  const saved = profile(view).map((line) => (line.length > 300 ? `${line.slice(0, 299)}…` : line));
  if (saved.length) lines.push('', ...saved);
  for (const { status, label } of statuses) {
    const notes = view.notes.filter((entry) => entry.status === status);
    if (notes.length)
      lines.push(
        '',
        `**${label}** (${notes.length})`,
        ...notes.map((entry) => `• ${text(entry.text)}`),
      );
  }
  if (!view.notes.length && !saved.length) lines.push('', 'Nothing yet.');
  const footer = [
    '',
    ...(view.archive.length ? [`Let go: ${view.archive.length}`] : []),
    link
      ? `See, change or export everything: ${link}`
      : 'Open Memory in Otto to see, change or export everything.',
  ].join('\n');
  const body: string[] = [];
  let used = footer.length;
  for (const [index, line] of lines.entries()) {
    if (used + line.length + 1 > limit) {
      body.push(
        `…and ${lines.slice(index).filter((rest) => rest && !rest.startsWith('**')).length} more`,
      );
      break;
    }
    body.push(line);
    used += line.length + 1;
  }
  return `${body.join('\n')}\n${footer}`;
}
